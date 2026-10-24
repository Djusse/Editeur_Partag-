/**
 * Enveloppe des handlers HTTP (API Gateway HTTP API, payload v2).
 * Toutes les réponses portent le CORS et ne laissent jamais fuiter une
 * exception brute : le visiteur reçoit toujours un des états explicites.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { config } from './config';
import { ApiError } from './errors';
import { verifySession, type Session } from './jwt';

export interface RequestContext {
  event: APIGatewayProxyEventV2;
  session?: Session;
  body: unknown;
  path: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
}

type Handler = (ctx: RequestContext) => Promise<ResponsePayload>;

export interface ResponsePayload {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function corsHeaders(): Record<string, string> {
  const origin = config().webOrigin;
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): ResponsePayload {
  return { status, body, headers };
}

/** Extrait le jeton Bearer (ou `?token=` en dernier recours pour les liens). */
export function bearerToken(ctx: RequestContext): string | undefined {
  const header = ctx.headers.authorization ?? ctx.headers.Authorization;
  if (header && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return undefined;
}

export async function requireSession(ctx: RequestContext): Promise<Session> {
  const token = bearerToken(ctx);
  const session = await verifySession(token);
  ctx.session = session;
  return session;
}

export async function requireAdmin(ctx: RequestContext): Promise<void> {
  const header = ctx.headers['x-admin-key'] ?? ctx.headers['X-Admin-Key'];
  const { adminKey } = await import('./jwt');
  const expected = await adminKey();
  if (!header || header !== expected) {
    const { forbidden } = await import('./errors');
    throw forbidden('ADMIN_REQUIRED', 'Clé d\'administration invalide');
  }
}

export function parseBody<T = unknown>(ctx: RequestContext): T {
  if (ctx.body === undefined || ctx.body === null || ctx.body === '') {
    throw new ApiError(400, 'EMPTY_BODY', 'Corps de requête attendu');
  }
  return ctx.body as T;
}

/** Fabrique un handler Lambda à partir d'une fonction métier. */
export function httpHandler(handler: Handler) {
  return async (event: APIGatewayProxyEventV2, _context: Context): Promise<APIGatewayProxyResultV2> => {
    const headers = normalizeHeaders(event.headers);
    let body: unknown = undefined;
    if (event.body) {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        return finish(json(400, { error: { code: 'INVALID_JSON', message: 'JSON invalide' } }));
      }
    }
    const ctx: RequestContext = {
      event,
      body,
      path: (event.pathParameters ?? {}) as Record<string, string>,
      query: (event.queryStringParameters ?? {}) as Record<string, string>,
      headers,
    };
    try {
      const result = await handler(ctx);
      return finish(result);
    } catch (error) {
      if (error instanceof ApiError) {
        return finish(
          json(error.status, {
            error: { code: error.code, message: error.message, ...(error.details ?? {}) },
          }, error.status === 200 ? {} : {}),
        );
      }
      // eslint-disable-next-line no-console
      console.error('Erreur non gérée', error);
      return finish(json(500, { error: { code: 'INTERNAL_ERROR', message: 'Erreur interne, réessayez' } }));
    }
  };
}

function finish(payload: ResponsePayload): APIGatewayProxyResultV2 {
  return {
    statusCode: payload.status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(), ...(payload.headers ?? {}) },
    body: typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body),
  };
}

function normalizeHeaders(raw: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string') {
      out[key.toLowerCase()] = value;
      out[key] = value;
    }
  }
  return out;
}

/** Réponse à une requête preflight. */
export function preflight(): ResponsePayload {
  return { status: 204, body: '' };
}
