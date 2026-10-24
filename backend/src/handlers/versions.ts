/**
 * Versions d'un document.
 *   GET  /documents/{id}/versions
 *   POST /documents/{id}/versions            → créer une version maintenant
 *   POST /documents/{id}/versions/{n}/restore
 */
import { badRequest } from '../lib/errors';
import { json, requireSession, type RequestContext, type ResponsePayload, httpHandler } from '../lib/http';
import { requireDocumentAccess } from '../lib/documents';
import { createVersion, listVersions, restoreVersion, validateVersionNumber } from '../lib/versions';
import { loadDocumentState, stateFromJournal } from '../lib/updates';

export async function listHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  const { doc } = await requireDocumentAccess(docId, session.email);
  const versions = await listVersions(docId);
  return json(200, { currentSeq: doc.seq, versions });
}

export async function createHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  const { doc } = await requireDocumentAccess(docId, session.email);
  const state = await loadDocumentState(docId);
  const snapshot = stateFromJournal(state.updates, state.snapshot);
  const row = await createVersion({
    docId,
    seq: doc.seq,
    state: snapshot,
    authorEmail: session.email,
    authorName: session.name,
    chars: doc.textLength,
  });
  return json(201, { version: { n: row.n, chars: row.chars, createdAt: row.createdAt } });
}

export async function restoreHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  await requireDocumentAccess(docId, session.email);
  const n = validateVersionNumber(ctx.path.n);
  const result = await restoreVersion({ docId, n, authorEmail: session.email, authorName: session.name });
  return json(200, { restored: n, seq: result.seq });
}

// --- exports Lambda (points d'entrée réellement déployés) ---
export const list = httpHandler(listHandler);
export const create = httpHandler(createHandler);
export const restore = httpHandler(restoreHandler);
