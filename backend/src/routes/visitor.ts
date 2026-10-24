/**
 * Parcours visiteur — aucune identité à donner.
 *
 *   GET  /d/{token}/status            → active | exhausted (+ title)
 *   POST /d/{token}/claim             → ready | waiting | exhausted
 *   GET  /d/{token}/file?visitorId=…  → mêmes réponses
 *
 * En-têtes de cache (nginx les honore via `X-Accel-Expires`) :
 *  - `active`    : 1 s (micro-cache, laisse passer le pic de `status`) ;
 *  - `exhausted` : 60 s (C6 : plus aucun calcul, réponse mémorisée).
 */
import type { FastifyInstance } from 'fastify';
import { claim, file, linkStatus, validateVisitorId, type ClaimResult } from '../lib/links';

function applyHeaders(reply: { header: (name: string, value: string) => void }, result: ClaimResult): void {
  if (result.status === 200) {
    reply.header('cache-control', 'no-store');
    return;
  }
  if (result.status === 202) {
    const retryAfter = 'retryAfter' in result.body ? result.body.retryAfter : 2;
    reply.header('cache-control', 'no-store');
    reply.header('retry-after', String(retryAfter));
    return;
  }
  reply.header('cache-control', 'public, max-age=60');
  reply.header('x-accel-expires', '60');
}

export function registerVisitorRoutes(app: FastifyInstance): void {
  app.get('/d/:token/status', async (request, reply) => {
    const { token } = request.params as { token: string };
    const status = await linkStatus(token);
    if (status.status === 'exhausted') {
      reply.header('cache-control', 'public, max-age=60');
      reply.header('x-accel-expires', '60');
    } else {
      reply.header('cache-control', 'public, max-age=1');
      reply.header('x-accel-expires', '1');
    }
    return status;
  });

  app.post('/d/:token/claim', async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = (request.body ?? {}) as { visitorId?: unknown };
    const visitorId = validateVisitorId(body.visitorId);
    const result = await claim(token, visitorId);
    applyHeaders(reply, result);
    reply.code(result.status);
    return result.body;
  });

  app.get('/d/:token/file', async (request, reply) => {
    const { token } = request.params as { token: string };
    const query = request.query as { visitorId?: string };
    const visitorId = validateVisitorId(query.visitorId);
    const result = await file(token, visitorId);
    applyHeaders(reply, result);
    reply.code(result.status);
    return result.body;
  });
}
