/**
 * Création de liens de téléchargement (côté rédacteur).
 *   POST /documents/{id}/links
 */
import { badRequest } from '../lib/errors';
import { json, parseBody, requireSession, type RequestContext, type ResponsePayload } from '../lib/http';
import { requireDocumentAccess } from '../lib/documents';
import { createLink } from '../lib/links';

export async function createHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  await requireDocumentAccess(docId, session.email);
  const body = parseBody<{ maxDownloads?: number }>(ctx);
  const link = await createLink({
    docId,
    maxDownloads: Number(body.maxDownloads ?? 500),
    createdByEmail: session.email,
    createdByName: session.name,
  });
  return json(201, {
    link: {
      token: link.token,
      maxDownloads: link.maxDownloads,
      remaining: link.remaining,
      status: link.status,
      path: `/d?token=${link.token}`,
    },
  });
}
