/**
 * Tickets WebSocket à usage unique (60 s).
 *
 * Le navigateur ne permet pas d'en-têtes personnalisés pendant le handshake
 * WebSocket : le ticket voyage en query string et n'est utilisable qu'une fois,
 * ce qui évite d'exposer le JWT durable dans les journaux d'API Gateway.
 */
import { config } from './config';
import { getItem, putItem, updateItem } from './db';
import { randomToken } from './ids';
import { unauthorized } from './errors';
import type { WsTicketRow } from './types';

export async function issueWsTicket(input: { email: string; name: string; docId: string }): Promise<{ ticket: string; expiresIn: number }> {
  const ttl = config().ticketTtlSeconds;
  const ticket = randomToken(24);
  const row: WsTicketRow = {
    ticket,
    email: input.email,
    name: input.name,
    docId: input.docId,
    exp: Math.floor(Date.now() / 1000) + ttl,
    used: false,
    ttl: Math.floor(Date.now() / 1000) + ttl + 30,
  };
  await putItem(config().wsTicketsTable, row as unknown as Record<string, unknown>, {
    condition: 'attribute_not_exists(ticket)',
  });
  return { ticket, expiresIn: ttl };
}

/** Consomme le ticket : une seule connexion acceptée, jamais deux. */
export async function consumeWsTicket(ticket: string): Promise<WsTicketRow> {
  if (!ticket) throw unauthorized('MISSING_TICKET', 'Ticket WebSocket absent');
  const row = await getItem<WsTicketRow>(config().wsTicketsTable, { ticket });
  if (!row) throw unauthorized('INVALID_TICKET', 'Ticket WebSocket inconnu ou expiré');
  if (row.used) throw unauthorized('USED_TICKET', 'Ticket WebSocket déjà utilisé');
  if (row.exp * 1000 < Date.now()) throw unauthorized('EXPIRED_TICKET', 'Ticket WebSocket expiré');

  try {
    await updateItem(
      config().wsTicketsTable,
      { ticket },
      {
        update: 'SET used = :true',
        condition: 'used = :false AND exp >= :now',
        values: { ':true': true, ':false': false, ':now': Math.floor(Date.now() / 1000) },
        returnValues: 'NONE',
      },
    );
  } catch {
    throw unauthorized('USED_TICKET', 'Ticket WebSocket déjà utilisé');
  }
  return row;
}
