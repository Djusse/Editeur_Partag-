/**
 * Connexions WebSocket et diffusion.
 *
 * Le fan-out est **groupé** : on ne poste pas un message par frappe et par
 * client (coût quadratique), mais un lot par tick. Les connexions mortes
 * (410 Gone) sont supprimées au passage.
 */
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { config } from './config';
import { deleteItem, getItem, putItem, query } from './db';
import type { ConnectionRow } from './types';

let api: ApiGatewayManagementApiClient | null = null;

function managementApi(): ApiGatewayManagementApiClient | null {
  const endpoint = config().wsEndpoint;
  if (!endpoint) return null;
  if (!api) api = new ApiGatewayManagementApiClient({ region: config().region, endpoint });
  return api;
}

export async function saveConnection(row: ConnectionRow): Promise<void> {
  await putItem(config().connectionsTable, row as unknown as Record<string, unknown>);
}

export async function getConnection(connectionId: string): Promise<ConnectionRow | undefined> {
  return getItem<ConnectionRow>(config().connectionsTable, { connectionId });
}

export async function removeConnection(connectionId: string): Promise<void> {
  await deleteItem(config().connectionsTable, { connectionId });
}

export async function listConnections(docId: string): Promise<ConnectionRow[]> {
  const result = await query<ConnectionRow>({
    table: config().connectionsTable,
    index: 'docId-index',
    keyCondition: 'docId = :docId',
    values: { ':docId': docId },
  });
  return result.items;
}

/**
 * Diffuse un message à toutes les connexions d'un document (sauf exclusion).
 * Les erreurs individuelles ne cassent jamais la diffusion.
 */
export async function broadcast(
  docId: string,
  message: unknown,
  options: { exclude?: string; batchSize?: number } = {},
): Promise<{ sent: number; pruned: number }> {
  const client = managementApi();
  if (!client) {
    console.warn('WS_ENDPOINT absent : diffusion ignorée');
    return { sent: 0, pruned: 0 };
  }
  const connections = await listConnections(docId);
  const targets = connections.filter((row) => row.connectionId !== options.exclude);
  const payload = Buffer.from(JSON.stringify(message));
  const batchSize = options.batchSize ?? 25;
  let sent = 0;
  let pruned = 0;

  for (let index = 0; index < targets.length; index += batchSize) {
    const batch = targets.slice(index, index + batchSize);
    await Promise.all(
      batch.map(async (target) => {
        try {
          await client.send(
            new PostToConnectionCommand({ ConnectionId: target.connectionId, Data: payload }),
          );
          sent++;
        } catch (error) {
          if (error instanceof GoneException || (error as { statusCode?: number }).statusCode === 410) {
            await removeConnection(target.connectionId).catch(() => undefined);
            pruned++;
            return;
          }
          console.warn('postToConnection en échec', { connectionId: target.connectionId, error });
        }
      }),
    );
  }
  return { sent, pruned };
}

/** Envoie un message à une connexion précise. */
export async function sendTo(connectionId: string, message: unknown): Promise<void> {
  const client = managementApi();
  if (!client) return;
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(message)),
      }),
    );
  } catch (error) {
    if (error instanceof GoneException || (error as { statusCode?: number }).statusCode === 410) {
      await removeConnection(connectionId).catch(() => undefined);
      return;
    }
    throw error;
  }
}

/** Liste de présence d'un document, telle qu'affichée dans l'éditeur. */
export async function presence(docId: string): Promise<Array<{ email: string; name: string; color: string; cursor?: number | null }>> {
  const rows = await listConnections(docId);
  const seen = new Set<string>();
  const out: Array<{ email: string; name: string; color: string; cursor?: number | null }> = [];
  for (const row of rows) {
    if (seen.has(row.email)) continue;
    seen.add(row.email);
    out.push({ email: row.email, name: row.name, color: row.color, cursor: row.cursor ?? null });
  }
  return out;
}
