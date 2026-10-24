/**
 * Parcours visiteur (aucune identité à donner).
 *   GET  /d/{token}/status  → active | exhausted (cache court, C5/C6)
 *   POST /d/{token}/claim   → ready | waiting | exhausted (idempotent, C1/C3)
 *   GET  /d/{token}/file    → URL présignée ou waiting
 */
import { badRequest } from '../lib/errors';
import { json, parseBody, type RequestContext, type ResponsePayload, httpHandler } from '../lib/http';
import { claimDownload, fileForVisitor, linkStatus, type ClaimResult } from '../lib/links';

const STATUS_CACHE_ACTIVE = 'public, max-age=2, stale-while-revalidate=3';
const STATUS_CACHE_EXHAUSTED = 'public, max-age=30, stale-while-revalidate=60';

function claimResponse(result: ClaimResult, headers: Record<string, string> = {}): ResponsePayload {
  if (result.state === 'ready') {
    return json(200, {
      state: 'ready',
      url: result.url,
      seq: result.seqFrozen,
      remaining: result.remaining,
      expiresIn: 60,
    }, { 'cache-control': 'no-store', ...headers });
  }
  if (result.state === 'waiting') {
    const retryAfter = result.retryAfter ?? 2;
    return json(202, {
      state: 'waiting',
      retryAfter,
      remaining: result.remaining,
      message: 'Le document se prépare, patientez un instant.',
    }, { 'cache-control': 'no-store', 'retry-after': String(retryAfter), ...headers });
  }
  return json(410, {
    state: 'exhausted',
    remaining: 0,
    message: 'Le lien a atteint son nombre maximal de téléchargements.',
  }, { 'cache-control': STATUS_CACHE_EXHAUSTED, ...headers });
}

export async function statusHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const token = ctx.path.token;
  if (!token) throw badRequest('MISSING_TOKEN', 'Jeton de lien manquant');
  const status = await linkStatus(token);
  return json(200, status, {
    'cache-control': status.status === 'exhausted' ? STATUS_CACHE_EXHAUSTED : STATUS_CACHE_ACTIVE,
  });
}

export async function claimHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const token = ctx.path.token;
  if (!token) throw badRequest('MISSING_TOKEN', 'Jeton de lien manquant');
  const body = parseBody<{ visitorId?: string }>(ctx);
  const visitorId = String(body.visitorId ?? '');
  if (!visitorId) throw badRequest('MISSING_VISITOR_ID', 'visitorId obligatoire');
  const result = await claimDownload(token, visitorId);
  return claimResponse(result);
}

export async function fileHandler(ctx: RequestContext): Promise<ResponsePayload> {
  const token = ctx.path.token;
  if (!token) throw badRequest('MISSING_TOKEN', 'Jeton de lien manquant');
  const visitorId = ctx.query.visitorId ?? '';
  if (!visitorId) throw badRequest('MISSING_VISITOR_ID', 'visitorId obligatoire');
  const result = await fileForVisitor(token, visitorId);
  return claimResponse(result);
}

// --- exports Lambda (points d'entrée réellement déployés) ---
export const status = httpHandler(statusHandler);
export const claim = httpHandler(claimHandler);
export const file = httpHandler(fileHandler);
