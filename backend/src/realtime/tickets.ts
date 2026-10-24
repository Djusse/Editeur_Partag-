/**
 * Tickets WebSocket à usage unique (mémoire uniquement).
 *
 * Le navigateur ne permet pas d'en-têtes personnalisés au handshake : le ticket
 * voyage dans l'URL. Il vaut 60 secondes et n'est consommable qu'une fois, ce qui
 * évite d'exposer un JWT durable dans les journaux nginx.
 */
import { config } from '../lib/config';
import { randomToken } from '../lib/ids';
import type { WsTicket } from '../lib/types';

const tickets = new Map<string, WsTicket>();

export function issueTicket(input: { email: string; name: string; docId: string }): { ticket: string; expiresIn: number } {
  const ttl = config().wsTicketTtlSeconds;
  const ticket = randomToken(24);
  tickets.set(ticket, {
    ticket,
    email: input.email,
    name: input.name,
    docId: input.docId,
    exp: Date.now() + ttl * 1000,
  });
  return { ticket, expiresIn: ttl };
}

/** Consomme le ticket : une seule connexion acceptée, jamais deux. */
export function consumeTicket(ticket: string): WsTicket | undefined {
  const entry = tickets.get(ticket);
  if (!entry) return undefined;
  tickets.delete(ticket);
  if (entry.exp < Date.now()) return undefined;
  return entry;
}

/** Purge périodique (les tickets non consommés ne doivent pas fuir). */
export function startTicketSweeper(): NodeJS.Timeout {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of tickets) {
      if (entry.exp < now) tickets.delete(key);
    }
  }, 60_000);
  timer.unref?.();
  return timer;
}

export function ticketCount(): number {
  return tickets.size;
}
