/**
 * Assemblage Fastify.
 *
 * Toutes les routes REST sont préfixées par `/api` : nginx proxifie `/api` vers
 * Node et sert le front statique directement, ce qui évite que le processus
 * applicatif traite des fichiers.
 *
 * CORS : en production, front et API partagent la même origine (nginx), donc
 * aucun en-tête CORS n'est nécessaire. En **développement**, le front tourne sur
 * `localhost:3000` et l'API sur `localhost:4000` : ce sont deux origines, et le
 * navigateur exige alors un préflight `OPTIONS` **avec** les en-têtes CORS.
 * Sans ce plugin, la connexion échoue avec « CORS header missing ».
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { existsSync } from 'node:fs';
import { config, publicConfig } from '../lib/config';
import { AppError } from '../lib/errors';
import { registerSessionRoutes } from '../routes/session';
import { registerDocumentRoutes } from '../routes/documents';
import { registerVisitorRoutes } from '../routes/visitor';
import { registerLinkRoutes } from '../routes/links';
import { registerAdminRoutes } from '../routes/admin';
import { registerWsTicketRoutes } from '../routes/ws-ticket';
import { manager } from '../realtime/manager';

export function buildApp(options: { staticDir?: string; logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  // --- CORS ---------------------------------------------------------------
  // Même origine en production : `WEB_ORIGIN` n'est alors pas défini et l'on
  // n'autorise que l'origine de la requête (aucun élargissement inutile).
  // En développement, `WEB_ORIGIN` liste explicitement l'interface.
  const origins = (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  void app.register(fastifyCors, {
    origin: origins.length > 0 ? origins : true,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-admin-key'],
    maxAge: 600,
    // Le service ne sert aucun cookie : pas besoin de credentials.
    strictPreflight: true,
  });

  // --- Gestion d'erreurs uniforme -----------------------------------------
  // L'interface attend `{error: "CODE", field?}` ; on ne laisse jamais fuiter
  // une exception brute, et jamais de 5xx silencieux.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.status);
      return {
        error: error.code,
        ...(error.field ? { field: error.field } : {}),
        message: error.message,
        ...(error.details ?? {}),
      };
    }

    const clientError = error as { statusCode?: number; message?: string };
    const statusCode = clientError.statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode);
      return { error: 'INVALID_INPUT', message: clientError.message ?? 'Requête invalide.' };
    }

    console.error('Erreur non gérée', error);
    reply.code(500);
    return { error: 'INTERNAL_ERROR', message: 'Une erreur est survenue. Réessayez dans un instant.' };
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404);
    return { error: 'NOT_FOUND', message: `Route inconnue : ${request.method} ${request.url}` };
  });

  // --- Santé --------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok', uptime: Math.round(process.uptime()), mode: config().mode }));

  // --- Configuration publique (aucun secret) ------------------------------
  app.get('/api/config', async () => publicConfig());

  // --- Routes du rédacteur (préfixe /api, proxifié par nginx) --------------
  void app.register(
    async (instance) => {
      registerSessionRoutes(instance);
      registerDocumentRoutes(instance);
      registerLinkRoutes(instance);
      registerWsTicketRoutes(instance);
      registerAdminRoutes(instance);
    },
    { prefix: '/api' },
  );

  // --- Parcours visiteur (à la RACINE) -------------------------------------
  // nginx sert `location /` (fichiers statiques) et `location /api/` (proxy) :
  // `/d/...` doit donc exister en dehors du préfixe `/api`, sinon les liens
  // publics renverraient 404 en production.
  registerVisitorRoutes(app);

  // --- Front statique -----------------------------------------------------
  // En production nginx sert le front ; ce repli intégré permet de lancer le
  // binaire seul (démonstration, mode local) sans configuration supplémentaire.
  const staticDir = options.staticDir ?? config().staticDir;
  if (existsSync(staticDir)) {
    void app.register(fastifyStatic, { root: staticDir, wildcard: false });
  }

  manager.startSweeper();
  return app;
}
