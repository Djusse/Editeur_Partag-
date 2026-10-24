/**
 * Supervision — `GET /api/admin/state`, protégée par la clé d'administration
 * (SSM Parameter Store, en-tête `X-Admin-Key`).
 *
 * Trois blocs, comme demandé par la spécification d'interface (section 11) :
 * documents ouverts, liens actifs, personnes bloquées.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../lib/config';
import { adminKey } from '../lib/secrets';
import { db } from '../lib/db';
import { unauthorized } from '../lib/errors';
import { manager } from '../realtime/manager';
import { utcDay } from '../lib/ids';
import type { AbuseRow, DocumentRow, LinkRow } from '../lib/types';

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/admin/state', async (request) => {
    const provided = request.headers['x-admin-key'];
    const expected = await adminKey();
    if (typeof provided !== 'string' || provided !== expected) {
      throw unauthorized('Clé d\'administration invalide.');
    }

    const cfg = config();
    const day = utcDay();

    const [documents, links, abuse] = await Promise.all([
      db().scan<DocumentRow>(cfg.documentsTable),
      db().scan<LinkRow>(cfg.linksTable),
      db().scan<AbuseRow>(cfg.abuseTable),
    ]);

    const openDocuments = manager.openDocuments().map((entry) => {
      const doc = documents.find((row) => row.docId === entry.docId);
      return {
        docId: entry.docId,
        title: doc?.title ?? '(inconnu)',
        connections: entry.connections,
      };
    });

    const activeLinks = links
      .filter((link) => link.status === 'ACTIVE' && link.remaining > 0)
      .map((link) => ({
        token: link.token,
        docId: link.docId,
        title: link.docTitle,
        maxDownloads: link.maxDownloads,
        remaining: link.remaining,
      }));

    const blocked = abuse
      .filter((row) => row.day === day && row.blockedUntil && new Date(row.blockedUntil).getTime() > Date.now())
      .map((row) => ({ email: row.email, blockedUntil: row.blockedUntil as string }));

    return { openDocuments, activeLinks, blocked };
  });
}
