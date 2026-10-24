/**
 * Protocole WebSocket (spécification d'interface, section 3.3).
 *
 * Messages client → serveur :
 *   join       {documentId, sinceSeq}
 *   update     {opId, documentId, payload (Base64)}
 *   awareness  {documentId, payload (Base64)}
 *   ping       {}
 *
 * Messages serveur → client :
 *   update     {seq, documentId, payload}   (un seul par tick, sans `author`)
 *   ack        {opIds, seq, creditRemaining}
 *   presence   {users:[{email,name}]}
 *   awareness  {documentId, payload}
 *   error      {code, opId?, creditRemaining?, blockedUntil?}
 *
 * Aucun message binaire : le service et le proxy nginx transmettent du texte,
 * et les updates Yjs voyagent en Base64 (plafond 64 Ko de binaire).
 */
import { WebSocket, type WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { config } from '../lib/config';
import { db } from '../lib/db';
import { AppError, WsErrorCodes } from '../lib/errors';
import { base64Size, base64ToBytes } from '../lib/base64';
import { colorFor, randomToken } from '../lib/ids';
import { requireAccess } from '../lib/documents';
import { assertNotBlocked } from '../lib/credits';
import { creditCost, InvalidUpdateError } from '../lib/yjs-update';
import { consumeTicket } from './tickets';
import { manager } from './manager';
import { hashOf, send, type Client, type IncomingUpdate } from './hub';

interface ClientMessage {
  type?: string;
  documentId?: string;
  sinceSeq?: number;
  opId?: string;
  payload?: string;
}

/** Installe le gestionnaire de connexions WebSocket sur un serveur `ws`. */
export function attachProtocol(wss: WebSocketServer): void {
  wss.on('connection', (socket, request) => {
    void handleConnection(socket, request);
  });
}

async function handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
  const url = new URL(request.url ?? '/ws', 'http://localhost');
  const ticketValue = url.searchParams.get('ticket') ?? '';
  const ticket = consumeTicket(ticketValue);

  if (!ticket) {
    closeWithError(socket, WsErrorCodes.forbidden, 'Ticket WebSocket invalide ou expiré.');
    return;
  }

  try {
    await requireAccess(ticket.docId, ticket.email);
  } catch {
    closeWithError(socket, WsErrorCodes.forbidden, 'Vous n\'avez pas accès à ce document.');
    return;
  }

  const client: Client = {
    id: randomToken(12),
    socket,
    email: ticket.email,
    name: ticket.name,
    color: colorFor(ticket.email),
    docId: ticket.docId,
    seq: 0,
    cursor: null,
  };

  const state = await manager.load(ticket.docId);
  client.seq = state.seq;
  manager.join(ticket.docId, state, client);

  const blocked = await assertNotBlocked(ticket.email).then(
    () => null,
    (error: AppError) => error,
  );

  send(client, {
    type: 'joined',
    connectionId: client.id,
    documentId: ticket.docId,
    seq: state.seq,
    you: { email: client.email, name: client.name, color: client.color },
    ...(blocked ? { readOnly: blocked.code } : {}),
  });

  socket.on('message', (raw: Buffer) => {
    void handleMessage(client, raw.toString('utf8'));
  });
  socket.on('close', () => {
    manager.leave(ticket.docId, client.id);
  });
  socket.on('error', () => {
    manager.leave(ticket.docId, client.id);
  });
}

async function handleMessage(client: Client, raw: string): Promise<void> {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    send(client, { type: 'error', code: 'INVALID_JSON', message: 'Message JSON invalide.' });
    return;
  }

  const type = message.type ?? '';

  if (type === 'ping') {
    send(client, { type: 'pong', at: Date.now() });
    return;
  }

  if (type === 'join') {
    await handleJoin(client, message);
    return;
  }

  if (type === 'awareness') {
    if (typeof message.payload === 'string' && message.payload.length > 0 && base64Size(message.payload) <= 16 * 1024) {
      client.awareness = message.payload;
      manager.broadcastAwareness(client.docId, client, message.payload);
    }
    return;
  }

  if (type === 'update') {
    await handleUpdate(client, message);
    return;
  }

  send(client, { type: 'error', code: 'UNKNOWN_TYPE', message: `Type de message inconnu : ${type}` });
}

/** `join {sinceSeq}` : envoie les updates manquants au client. */
async function handleJoin(client: Client, message: ClientMessage): Promise<void> {
  const since = Number.isFinite(message.sinceSeq) ? Number(message.sinceSeq) : 0;
  const state = manager.get(client.docId);
  if (!state) {
    send(client, { type: 'error', code: 'DOCUMENT_NOT_LOADED' });
    return;
  }

  client.seq = Math.max(client.seq, since);
  const missing = await manager.updatesSince(client.docId, since);
  for (const update of missing) {
    send(client, {
      type: 'update',
      seq: update.seq,
      documentId: client.docId,
      payload: Buffer.from(update.payload).toString('base64'),
    });
    client.seq = Math.max(client.seq, update.seq);
  }

  send(client, { type: 'joined', seq: state.seq, documentId: client.docId, caughtUp: missing.length });
  manager.broadcastPresence(client.docId);
}

/** `update {opId, payload}` : validation, mise en file, acquittement différé. */
async function handleUpdate(client: Client, message: ClientMessage): Promise<void> {
  const opId = typeof message.opId === 'string' ? message.opId.trim() : '';
  if (!opId || opId.length > 100) {
    send(client, { type: 'error', code: 'INVALID_OP_ID', message: 'opId obligatoire (max 100 caractères).' });
    return;
  }

  const payloadBase64 = typeof message.payload === 'string' ? message.payload : '';
  if (!payloadBase64) {
    send(client, { type: 'error', code: WsErrorCodes.payloadTooLarge, opId, message: 'Update absent.' });
    return;
  }

  const cfg = config();
  if (base64Size(payloadBase64) > cfg.maxUpdateBytes) {
    send(client, {
      type: 'error',
      code: WsErrorCodes.payloadTooLarge,
      opId,
      message: 'Cette modification est trop volumineuse et n\'a pas été enregistrée.',
    });
    return;
  }

  const payload = base64ToBytes(payloadBase64);

  let counts: { inserted: number; deleted: number; structs: number };
  try {
    counts = creditCost(payload).counts;
  } catch (error) {
    const message = error instanceof InvalidUpdateError ? error.message : 'Update illisible.';
    send(client, { type: 'error', code: 'INVALID_UPDATE', opId, message });
    return;
  }

  // Blocage : refus immédiat, sans toucher au journal.
  try {
    await assertNotBlocked(client.email);
  } catch (error) {
    const blocked = error as AppError;
    send(client, {
      type: 'error',
      code: WsErrorCodes.blocked,
      opId,
      ...(blocked.details ?? {}),
      message: blocked.message,
    });
    return;
  }

  const state = manager.get(client.docId);
  if (!state) {
    send(client, { type: 'error', code: 'DOCUMENT_NOT_LOADED', opId });
    return;
  }

  const update: IncomingUpdate = {
    client,
    opId,
    payload,
    chars: counts.inserted + counts.deleted,
    inserted: counts.inserted,
    deleted: counts.deleted,
    hash: hashOf(payload),
  };

  state.enqueue(update);
}

function closeWithError(socket: WebSocket, code: string, message: string): void {
  try {
    socket.send(JSON.stringify({ type: 'error', code, message }));
  } catch {
    /* la connexion est peut-être déjà fermée */
  }
  socket.close(1008, code);
}

/** Vérifie l'appartenance d'un utilisateur (utilisé par `POST /ws-ticket`). */
export async function canOpenDocument(docId: string, email: string): Promise<boolean> {
  const member = await db().get<{ email: string }>(config().membersTable, { docId, email });
  return Boolean(member);
}
