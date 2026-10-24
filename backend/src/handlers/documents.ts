/**
 * CRUD documents et membres.
 *   GET  /documents            → liste
 *   POST /documents            → création
 *   GET  /documents/{id}       → détail + membres + liens
 *   PATCH /documents/{id}      → renommer
 *   DELETE /documents/{id}     → supprimer (propriétaire)
 *   POST /documents/{id}/members → partager
 */
import { badRequest, forbidden } from '../lib/errors';
import { json, parseBody, requireSession, type RequestContext, type ResponsePayload } from '../lib/http';
import {
  addMember,
  createDocument,
  deleteDocument,
  listDocumentsFor,
  listMembers,
  renameDocument,
  requireDocumentAccess,
} from '../lib/documents';
import { listLinksForDocument } from '../lib/links';

export async function listHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const documents = await listDocumentsFor(session.email);
  return json(200, { documents });
}

export async function createHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const body = parseBody<{ title?: string }>(ctx);
  const doc = await createDocument({
    title: body.title ?? '',
    ownerEmail: session.email,
    ownerName: session.name,
  });
  return json(201, { document: doc });
}

export async function getHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  const { doc, member } = await requireDocumentAccess(docId, session.email);
  const [members, links] = await Promise.all([listMembers(docId), listLinksForDocument(docId)]);
  return json(200, {
    document: doc,
    role: member.role,
    members,
    links: links.map((link) => ({
      token: link.token,
      maxDownloads: link.maxDownloads,
      remaining: link.remaining,
      status: link.status,
      createdAt: link.createdAt,
    })),
  });
}

export async function renameHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  await requireDocumentAccess(docId, session.email);
  const body = parseBody<{ title?: string }>(ctx);
  await renameDocument(docId, body.title ?? '');
  return json(200, { ok: true });
}

export async function deleteHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  const { doc } = await requireDocumentAccess(docId, session.email);
  if (doc.ownerEmail !== session.email) throw forbidden('OWNER_ONLY', 'Seul le propriétaire peut supprimer');
  await deleteDocument(docId);
  return json(200, { ok: true });
}

export async function addMemberHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  await requireDocumentAccess(docId, session.email);
  const body = parseBody<{ email?: string; name?: string }>(ctx);
  const member = await addMember({
    docId,
    email: String(body.email ?? ''),
    name: String(body.name ?? ''),
    addedBy: session.email,
  });
  return json(201, { member });
}
