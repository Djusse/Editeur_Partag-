/**
 * Routes WebSocket (API Gateway WebSocket).
 *
 *   $connect    : consomme le ticket à usage unique, enregistre la connexion
 *   update      : applique la transaction atomique (seq + update + crédit + opId)
 *   awareness   : présence et curseurs (non persisté, non facturé)
 *   ping        : maintien de connexion
 *   $disconnect : nettoie la connexion et rediffuse la présence
 *
 * Les trames binaires sont interdites par le service (code 1003) : tout passe
 * en JSON, les updates Yjs sont en Base64 et plafonnées à 16 Ko de binaire.
 */
import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResult } from 'aws-lambda';
import { config } from '../lib/config';
import { getItem } from '../lib/db';
import { assertMember } from '../lib/documents';
import { ApiError, ErrorCodes } from '../lib/errors';
import { colorFor } from '../lib/ids';
import { broadcast, removeConnection, saveConnection, sendTo, presence } from '../lib/connections';
import { commitUpdate, compactIfNeeded, prepareUpdate } from '../lib/updates';
import { consumeWsTicket } from '../lib/ws-tickets';
import { base64ToBytes, base64Size, bytesToBase64 } from '../lib/base64';
import type { ConnectionRow, DocumentRow } from '../lib/types';

const CONNECTION_TTL_SECONDS = 12 * 3600;

function ok(): APIGatewayProxyResult {
  return { statusCode: 200, body: 'ok' };
}

function context(event: APIGatewayProxyWebsocketEventV2) {
  return (event.requestContext ?? {}) as {
    connectionId?: string;
    routeKey?: string;
    eventType?: string;
    queryStringParameters?: Record<string, string>;
    domainName?: string;
    stage?: string;
  };
}

export async function connectHandler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResult> {
  const ctx = context(event);
  const connectionId = ctx.connectionId;
  if (!connectionId) return { statusCode: 400, body: 'connectionId manquant' };
  try {
    const ticketValue = ctx.queryStringParameters?.ticket ?? '';
    const ticket = await consumeWsTicket(ticketValue);
    await assertMember(ticket.docId, ticket.email);

    const row: ConnectionRow = {
      connectionId,
      docId: ticket.docId,
      email: ticket.email,
      name: ticket.name,
      color: colorFor(ticket.email),
      cursor: null,
      joinedAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS,
    };
    await saveConnection(row);

    const doc = await getItem<DocumentRow>(config().documentsTable, { docId: ticket.docId });
    await sendTo(connectionId, {
      type: 'joined',
      connectionId,
      documentId: ticket.docId,
      title: doc?.title ?? '',
      seq: doc?.seq ?? 0,
      you: { email: ticket.email, name: ticket.name, color: row.color },
    });
    await broadcast(ticket.docId, { type: 'presence', people: await presence(ticket.docId) }, { exclude: connectionId });
    return ok();
  } catch (error) {
    console.warn('Connexion WebSocket refusée', (error as Error).message);
    // On répond 401 : API Gateway ferme alors la connexion.
    return { statusCode: 401, body: 'non autorisé' };
  }
}

export async function disconnectHandler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResult> {
  const ctx = context(event);
  const connectionId = ctx.connectionId;
  if (!connectionId) return ok();
  const row = await getItem<ConnectionRow>(config().connectionsTable, { connectionId });
  await removeConnection(connectionId);
  if (row) {
    await broadcast(row.docId, { type: 'presence', people: await presence(row.docId) }).catch(() => undefined);
  }
  return ok();
}

interface IncomingMessage {
  type?: string;
  documentId?: string;
  opId?: string;
  payload?: string;
  update?: string;
  cursor?: number | null;
  color?: string;
}

export async function messageHandler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResult> {
  const ctx = context(event);
  const connectionId = ctx.connectionId;
  if (!connectionId) return ok();

  const connection = await getItem<ConnectionRow>(config().connectionsTable, { connectionId });
  if (!connection) {
    return ok(); // Connexion inconnue : rien à faire, le TTL nettoiera.
  }

  let message: IncomingMessage;
  try {
    const raw = event.body ?? '';
    if (!raw) return ok();
    message = JSON.parse(event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw) as IncomingMessage;
  } catch {
    await sendTo(connectionId, { type: 'error', code: 'INVALID_JSON', message: 'Message JSON invalide' });
    return ok();
  }

  const route = message.type ?? ctx.routeKey ?? '';

  if (route === 'ping') {
    await sendTo(connectionId, { type: 'pong', at: Date.now() });
    return ok();
  }

  if (route === 'awareness') {
    const cursor = typeof message.cursor === 'number' ? message.cursor : null;
    await saveConnection({ ...connection, cursor });
    await broadcast(
      connection.docId,
      {
        type: 'awareness',
        email: connection.email,
        name: connection.name,
        color: connection.color,
        cursor,
      },
      { exclude: connectionId },
    ).catch(() => undefined);
    return ok();
  }

  if (route !== 'update') {
    await sendTo(connectionId, { type: 'error', code: 'UNKNOWN_TYPE', message: `Type de message inconnu : ${route}` });
    return ok();
  }

  const opId = typeof message.opId === 'string' ? message.opId : '';
  if (!opId || opId.length > 100) {
    await sendTo(connectionId, { type: 'error', code: 'INVALID_OP_ID', message: 'opId obligatoire (max 100 caractères)' });
    return ok();
  }

  const payloadBase64 = typeof message.payload === 'string' ? message.payload : typeof message.update === 'string' ? message.update : '';
  if (!payloadBase64) {
    await sendTo(connectionId, { type: 'error', code: ErrorCodes.invalidUpdate, message: 'payload (Base64) obligatoire' });
    return ok();
  }
  if (base64Size(payloadBase64) > config().maxUpdateBytes) {
    await sendTo(connectionId, {
      type: 'error',
      code: 'PAYLOAD_TOO_LARGE',
      message: `Update trop volumineux (max ${config().maxUpdateBytes} octets de binaire)`,
      opId,
    });
    return ok();
  }

  const payload = base64ToBytes(payloadBase64);
  try {
    prepareUpdate(payload);
  } catch (error) {
    const code = error instanceof ApiError ? error.code : ErrorCodes.invalidUpdate;
    await sendTo(connectionId, { type: 'error', code, message: (error as Error).message, opId });
    return ok();
  }

  try {
    const result = await commitUpdate({
      docId: connection.docId,
      authorEmail: connection.email,
      authorName: connection.name,
      opId,
      payload,
    });

    await sendTo(connectionId, {
      type: 'ack',
      opId,
      seq: result.seq,
      duplicate: result.duplicate,
      chars: result.chars,
    });

    if (!result.duplicate) {
      await broadcast(
        connection.docId,
        {
          type: 'update',
          documentId: connection.docId,
          seq: result.seq,
          opId,
          author: connection.email,
          authorName: connection.name,
          payload: bytesToBase64(payload),
        },
        { exclude: connectionId },
      ).catch(() => undefined);
      // Compaction opportuniste : sans elle, le journal grandit indéfiniment et
      // le chargement d'un document finirait par dépasser le temps imparti.
      await compactIfNeeded(connection.docId).catch((error) => {
        console.warn('Compaction ignorée', { docId: connection.docId, error });
      });
    }
    return ok();
  } catch (error) {
    if (error instanceof ApiError) {
      await sendTo(connectionId, {
        type: 'error',
        code: error.code,
        message: error.message,
        opId,
        ...(error.details ?? {}),
      });
      return ok();
    }
    console.error('Échec de commit d\'un update', error);
    await sendTo(connectionId, {
      type: 'error',
      code: 'INTERNAL_ERROR',
      message: 'Écriture impossible, réessayez',
      opId,
      retryable: true,
    });
    return ok();
  }
}
