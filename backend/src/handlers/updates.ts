/**
 * Repli HTTP du temps réel (mêmes updates Yjs, mêmes règles de crédit) et
 * endpoints de lecture du journal.
 *   POST /documents/{id}/updates         → { opId, update (Base64) }
 *   GET  /documents/{id}/updates?since=  → updates manquants
 *   GET  /documents/{id}/state           → snapshot + updates (nouveau client)
 */
import { badRequest } from '../lib/errors';
import { json, parseBody, requireSession, type RequestContext, type ResponsePayload, httpHandler } from '../lib/http';
import { requireDocumentAccess } from '../lib/documents';
import { commitUpdate, loadDocumentState, listUpdatesSince, prepareUpdate } from '../lib/updates';
import { broadcast } from '../lib/connections';
import { base64ToBytes, bytesToBase64 } from '../lib/base64';

export async function postHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  await requireDocumentAccess(docId, session.email);
  const body = parseBody<{ opId?: string; update?: string }>(ctx);
  const opId = String(body.opId ?? '');
  if (!opId || opId.length > 100) throw badRequest('INVALID_OP_ID', 'opId obligatoire (max 100 caractères)');
  const bytes = base64ToBytes(String(body.update ?? ''));
  prepareUpdate(bytes);

  const result = await commitUpdate({
    docId,
    authorEmail: session.email,
    authorName: session.name,
    opId,
    payload: bytes,
  });

  if (!result.duplicate) {
    await broadcast(docId, {
      type: 'update',
      documentId: docId,
      seq: result.seq,
      opId,
      author: session.email,
      payload: bytesToBase64(bytes),
    }).catch(() => undefined);
  }

  return json(200, {
    ack: { opId, seq: result.seq, duplicate: result.duplicate, chars: result.chars },
  });
}

export async function listHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  await requireDocumentAccess(docId, session.email);
  const since = Number(ctx.query.since ?? 0);
  const updates = await listUpdatesSince(docId, Number.isFinite(since) ? since : 0);
  return json(200, {
    updates: updates.map((row) => ({
      seq: row.seq,
      author: row.authorEmail,
      authorName: row.authorName,
      opId: row.opId,
      payload: bytesToBase64(row.payload),
      createdAt: row.createdAt,
    })),
  });
}

export async function stateHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const docId = ctx.path.id;
  if (!docId) throw badRequest('MISSING_DOC_ID', 'Identifiant de document manquant');
  const { doc } = await requireDocumentAccess(docId, session.email);
  const state = await loadDocumentState(docId);
  return json(200, {
    document: { docId: doc.docId, title: doc.title, seq: doc.seq, textLength: doc.textLength },
    seq: state.seq,
    snapshot: state.snapshot ? bytesToBase64(state.snapshot) : null,
    updates: state.updates.map((row) => ({
      seq: row.seq,
      author: row.authorEmail,
      payload: bytesToBase64(row.payload),
    })),
  });
}

// --- exports Lambda (points d'entrée réellement déployés) ---
export const post = httpHandler(postHandler);
export const list = httpHandler(listHandler);
export const state = httpHandler(stateHandler);
