/**
 * Serveur de développement local — **aucun compte AWS requis**.
 *
 * Il exécute les **vrais** handlers HTTP du projet (`backend/src/handlers`),
 * avec seulement trois substitutions :
 *   - DynamoDB → double en mémoire (même fichier que les tests unitaires) ;
 *   - S3       → stockage en mémoire + route `/__files/...` pour les PDF ;
 *   - SSM      → secrets générés en mémoire (JWT, clé admin).
 *
 * Ce qui est réellement exercé : claim et quota (C1), transactions et crédit
 * (C4), journal CRDT et séquences (C2), génération PDF servie par HTTP,
 * versions, supervision. Ce qui n'est **pas** exercé : WebSocket, SES,
 * CloudFront, IAM, et donc les limites de charge.
 *
 * Usage : npm run dev:local   (port 4000 par défaut)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { MemoryDynamo } from '../../test/helpers/memory-dynamo';
import { MemoryObjectStore } from './object-store';
import { setDdbClient } from '../lib/db';
import { setObjectStore, setPresignerOverride } from '../lib/s3';
import { resetConfigCache } from '../lib/config';

process.env.JWT_SECRET_PARAM = 'local/jwt-secret';
process.env.ADMIN_KEY_PARAM = 'local/admin-key';

/** Deux secrets distincts : la clé admin ne doit jamais être le secret JWT. */
const LOCAL_ADMIN_KEY = randomBytes(16).toString('base64url');
const LOCAL_JWT_SECRET_VALUE = randomBytes(32).toString('base64url');

/**
 * Interception de SSM : les handlers lisent leurs secrets par `SSMClient`.
 * On remplace `send` **avant** de charger un handler (imports dynamiques plus
 * bas), ce qui évite d'avoir besoin d'un compte AWS.
 */
import { SSMClient } from '@aws-sdk/client-ssm';

const originalSend = SSMClient.prototype.send;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(SSMClient.prototype as any).send = async function patched(
  this: SSMClient,
  command: { constructor: { name: string }; input?: { Name?: string } },
  options?: unknown,
) {
  const name = command.constructor.name;
  if (name === 'GetParameterCommand' || name === 'PutParameterCommand') {
    const parameterName = String(command.input?.Name ?? '');
    const value = parameterName.endsWith('/admin-key') ? LOCAL_ADMIN_KEY : LOCAL_JWT_SECRET_VALUE;
    return { Parameter: { Name: parameterName, Value: value, Type: 'SecureString' } };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalSend as any).call(this, command, options);
};

// --- tables -----------------------------------------------------------------
const TABLE_DEFINITIONS: Array<[string, string[]]> = [
  ['Documents', ['docId']],
  ['Members', ['docId', 'email']],
  ['Updates', ['docId', 'seq']],
  ['Connections', ['connectionId']],
  ['Credits', ['id']],
  ['OpIds', ['id']],
  ['Abuse', ['id']],
  ['Links', ['token']],
  ['Tickets', ['token', 'visitorId']],
  ['WsTickets', ['ticket']],
  ['PdfCache', ['id']],
  ['Versions', ['docId', 'n']],
];

const memory = new MemoryDynamo();
for (const [name, key] of TABLE_DEFINITIONS) memory.createTable(name, key);

const ENV: Record<string, string> = {
  DOCUMENTS_TABLE: 'Documents',
  MEMBERS_TABLE: 'Members',
  UPDATES_TABLE: 'Updates',
  CONNECTIONS_TABLE: 'Connections',
  CREDITS_TABLE: 'Credits',
  OPIDS_TABLE: 'OpIds',
  ABUSE_TABLE: 'Abuse',
  LINKS_TABLE: 'Links',
  TICKETS_TABLE: 'Tickets',
  WSTICKETS_TABLE: 'WsTickets',
  PDFCACHE_TABLE: 'PdfCache',
  VERSIONS_TABLE: 'Versions',
  PDF_BUCKET: 'local-bucket',
  SES_SENDER: 'local@exemple.test',
  WEB_ORIGIN: '*',
  AWS_REGION: 'eu-west-3',
};
Object.assign(process.env, ENV);

resetConfigCache();
setDdbClient(memory.client());

const objects = new MemoryObjectStore();
setObjectStore(objects);

const PORT = Number(process.env.LOCAL_PORT ?? 4000);
const BASE_URL = process.env.LOCAL_BASE_URL ?? `http://localhost:${PORT}`;

// L'URL « présignée » pointe sur le serveur local : le PDF se télécharge
// vraiment depuis le navigateur, ce qui valide le parcours visiteur complet.
setPresignerOverride(async (key, filename) => `${BASE_URL}/__files/${key}?filename=${encodeURIComponent(filename)}`);

/**
 * En local, la Lambda PDF n'existe pas : on exécute `buildPdfForVersion`
 * directement en tâche de fond, ce qui reproduit le comportement asynchrone
 * du déploiement (le visiteur reçoit bien `waiting` puis `ready`).
 */
process.env.PDF_FUNCTION_NAME = 'local-pdf-runner';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { buildPdfForVersion } from '../lib/pdf';

type LambdaSend = LambdaClient['send'];
const originalLambdaSend = LambdaClient.prototype.send;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(LambdaClient.prototype as any).send = async function patched(
  this: LambdaClient,
  command: { constructor: { name: string }; input?: { Payload?: Uint8Array } },
  options?: unknown,
) {
  if (command.constructor.name === 'InvokeCommand') {
    const payload = JSON.parse(Buffer.from(command.input?.Payload ?? new Uint8Array()).toString('utf8'));
    // Exécution non bloquante : le handler répond `waiting` immédiatement.
    setImmediate(() => {
      buildPdfForVersion(payload).catch((error) => {
        // eslint-disable-next-line no-console
        console.error('Génération PDF locale en échec', error);
      });
    });
    return { StatusCode: 202 };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalLambdaSend as any).call(this, command, options);
};

// --- routage ----------------------------------------------------------------
type LambdaResult = { statusCode: number; body: string; headers?: Record<string, string> };
type Handler = (event: unknown, context?: unknown) => Promise<LambdaResult>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  load: () => Promise<Handler>;
}

function route(method: string, path: string, load: () => Promise<Handler>): Route {
  const keys: string[] = [];
  const source = path.replace(/\{(\w+)\}/g, (_match, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, load };
}

const h = <T>(modulePromise: Promise<T>, name: keyof T) => async () => {
  const module = await modulePromise;
  return module[name] as unknown as Handler;
};

const routes: Route[] = [
  route('POST', '/session', h(import('../handlers/session'), 'handler')),
  route('GET', '/documents', h(import('../handlers/documents'), 'list')),
  route('POST', '/documents', h(import('../handlers/documents'), 'create')),
  route('GET', '/documents/{id}', h(import('../handlers/documents'), 'get')),
  route('PATCH', '/documents/{id}', h(import('../handlers/documents'), 'rename')),
  route('DELETE', '/documents/{id}', h(import('../handlers/documents'), 'remove')),
  route('POST', '/documents/{id}/members', h(import('../handlers/documents'), 'addMember')),
  route('POST', '/documents/{id}/links', h(import('../handlers/links'), 'create')),
  route('GET', '/documents/{id}/state', h(import('../handlers/updates'), 'state')),
  route('POST', '/documents/{id}/updates', h(import('../handlers/updates'), 'post')),
  route('GET', '/documents/{id}/updates', h(import('../handlers/updates'), 'list')),
  route('GET', '/documents/{id}/versions', h(import('../handlers/versions'), 'list')),
  route('POST', '/documents/{id}/versions', h(import('../handlers/versions'), 'create')),
  route('POST', '/documents/{id}/versions/{n}/restore', h(import('../handlers/versions'), 'restore')),
  route('GET', '/me/credit', h(import('../handlers/credit'), 'lambda')),
  route('POST', '/ws-ticket', h(import('../handlers/ws-ticket'), 'lambda')),
  route('GET', '/admin/state', h(import('../handlers/admin'), 'lambda')),
  route('GET', '/d/{token}/status', h(import('../handlers/visitor'), 'status')),
  route('POST', '/d/{token}/claim', h(import('../handlers/visitor'), 'claim')),
  route('GET', '/d/{token}/file', h(import('../handlers/visitor'), 'file')),
];

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'access-control-allow-origin': '*', ...headers });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', BASE_URL);
  const method = (request.method ?? 'GET').toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (method === 'OPTIONS') {
    send(response, 204, '', {
      'access-control-allow-headers': 'content-type,authorization,x-admin-key',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    });
    return;
  }

  // Fichiers « S3 » : PDF et snapshots servis tels quels.
  if (path.startsWith('/__files/')) {
    const key = decodeURIComponent(path.slice('/__files/'.length));
    if (!objects.has(key)) {
      send(response, 404, 'objet introuvable', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    const body = await objects.get(key);
    const filename = url.searchParams.get('filename') ?? 'document.pdf';
    send(response, 200, body, {
      'content-type': objects.contentType(key),
      'content-disposition': `inline; filename="${filename.replace(/"/g, '')}"`,
    });
    return;
  }

  // Diagnostic : état des « tables » et clé admin, sans AWS.
  if (path === '/__debug') {
    send(
      response,
      200,
      JSON.stringify(
        {
          adminKey: LOCAL_ADMIN_KEY,
          tables: Object.fromEntries([...memory.tables.keys()].map((name) => [name, memory.count(name)])),
          objects: objects.size(),
        },
        null,
        2,
      ),
      { 'content-type': 'application/json' },
    );
    return;
  }

  const matched = routes.find((candidate) => candidate.method === method && candidate.pattern.test(path));
  if (!matched) {
    send(
      response,
      404,
      JSON.stringify({ error: { code: 'NOT_FOUND', message: `Route inconnue : ${method} ${path}` } }),
      { 'content-type': 'application/json; charset=utf-8' },
    );
    return;
  }

  const match = matched.pattern.exec(path)!;
  const pathParameters: Record<string, string> = {};
  matched.keys.forEach((key, index) => {
    pathParameters[key] = decodeURIComponent(match[index + 1]);
  });

  const rawBody = await readBody(request);
  const event = {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: url.search.slice(1),
    pathParameters,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(
      Object.entries(request.headers).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])),
    ),
    body: rawBody || undefined,
    isBase64Encoded: false,
    requestContext: { http: { method, path } },
  };

  try {
    const handler = await matched.load();
    const result = await handler(event);
    // eslint-disable-next-line no-console
    console.log(`${method} ${path} → ${result.statusCode}`);
    send(response, result.statusCode, result.body ?? '', {
      'content-type': 'application/json; charset=utf-8',
      ...(result.headers ?? {}),
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`${method} ${path} → 500`, error);
    send(response, 500, JSON.stringify({ error: { code: 'LOCAL_ERROR', message: (error as Error).message } }), {
      'content-type': 'application/json; charset=utf-8',
    });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`
┌─────────────────────────────────────────────────────────────────────┐
│  Serveur local — aucun appel AWS                                    │
├─────────────────────────────────────────────────────────────────────┤
│  API         : ${BASE_URL}
│  Diagnostic  : ${BASE_URL}/__debug
│  Clé admin   : ${LOCAL_ADMIN_KEY}
│                                                                     │
│  REST complet, PDF servi par /__files/*, tests de quota et crédit   │
│  Non simulé : WebSocket (repli HTTP utilisé), SES, CloudFront       │
└─────────────────────────────────────────────────────────────────────┘
`);
});
