/**
 * POST /api/ws-ticket : ticket à usage unique (60 s) pour ouvrir le WebSocket.
 * L'accès au document est vérifié **à l'émission**, pas seulement à la connexion.
 */
import type { FastifyInstance } from 'fastify';
import { invalidInput } from '../lib/errors';
import { requireAccess } from '../lib/documents';
import { issueTicket } from '../realtime/tickets';
import { requireUser } from './documents';

export function registerWsTicketRoutes(app: FastifyInstance): void {
  app.post('/ws-ticket', async (request, reply) => {
    const user = await requireUser(request);
    const body = (request.body ?? {}) as { documentId?: unknown; docId?: unknown };
    const docId = String(body.documentId ?? body.docId ?? '');
    if (!docId) throw invalidInput('documentId', 'documentId obligatoire.');

    await requireAccess(docId, user.email);
    const ticket = issueTicket({ email: user.email, name: user.name, docId });

    reply.code(201);
    return { ticket: ticket.ticket, expiresIn: ticket.expiresIn, documentId: docId };
  });
}
