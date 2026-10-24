/** POST /api/documents/{id}/links : création d'un lien à quota strict. */
import type { FastifyInstance } from 'fastify';
import { requireAccess } from '../lib/documents';
import { createLink, validateMaxDownloads } from '../lib/links';
import { requireUser } from './documents';

export function registerLinkRoutes(app: FastifyInstance): void {
  app.post('/documents/:id/links', async (request, reply) => {
    const user = await requireUser(request);
    const { id } = request.params as { id: string };
    const { doc } = await requireAccess(id, user.email);

    const body = (request.body ?? {}) as { maxDownloads?: unknown };
    const maxDownloads = validateMaxDownloads(body.maxDownloads ?? 500);

    const link = await createLink({
      docId: id,
      docTitle: doc.title,
      maxDownloads,
      createdByEmail: user.email,
      createdByName: user.name,
    });

    reply.code(201);
    return {
      token: link.token,
      maxDownloads: link.maxDownloads,
      remaining: link.remaining,
      status: link.status,
      createdAt: link.createdAt,
    };
  });
}
