/** POST /ws-ticket : ticket à usage unique pour ouvrir le WebSocket. */
import { badRequest } from '../lib/errors';
import { json, parseBody, requireSession, type RequestContext, type ResponsePayload , httpHandler } from '../lib/http';
import { requireDocumentAccess } from '../lib/documents';
import { issueWsTicket } from '../lib/ws-tickets';

export async function handler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const body = parseBody<{ docId?: string }>(ctx);
  const docId = String(body.docId ?? '');
  if (!docId) throw badRequest('MISSING_DOC_ID', 'docId obligatoire');
  await requireDocumentAccess(docId, session.email);
  const ticket = await issueWsTicket({ email: session.email, name: session.name, docId });
  return json(201, { ...ticket, docId });
}

// --- export Lambda (point d'entrée réellement déployé) ---
export const lambda = httpHandler(handler);
