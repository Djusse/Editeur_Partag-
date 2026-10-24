/**
 * GET /admin/state — supervision (clé admin dans SSM, en-tête X-Admin-Key).
 * Documents ouverts, liens actifs avec restants, personnes bloquées.
 */
import { config } from '../lib/config';
import { query, scan } from '../lib/db';
import { json, requireAdmin, type RequestContext, type ResponsePayload } from '../lib/http';
import { scanDocuments } from '../lib/documents';
import { utcDay } from '../lib/ids';
import type { AbuseRow, ConnectionRow, CreditRow, LinkRow } from '../lib/types';

export async function handler(ctx: RequestContext): Promise<ResponsePayload> {
  await requireAdmin(ctx);
  const cfg = config();

  const [documents, connections, credits, abuse] = await Promise.all([
    scanDocuments(500),
    scan<ConnectionRow>({ table: cfg.connectionsTable, limit: 1000 }),
    scan<CreditRow>({ table: cfg.creditsTable, limit: 1000 }),
    scan<AbuseRow>({ table: cfg.abuseTable, limit: 1000 }),
  ]);

  const openDocIds = new Set(connections.items.map((row) => row.docId));
  const linksByDoc = new Map<string, LinkRow[]>();
  await Promise.all(
    [...openDocIds].map(async (docId) => {
      const result = await query<LinkRow>({
        table: cfg.linksTable,
        index: 'docId-index',
        keyCondition: 'docId = :docId',
        values: { ':docId': docId },
      });
      linksByDoc.set(docId, result.items);
    }),
  );

  const now = Date.now();
  const today = utcDay();

  return json(200, {
    generatedAt: new Date().toISOString(),
    totals: {
      documents: documents.length,
      openDocuments: openDocIds.size,
      connections: connections.items.length,
    },
    openDocuments: [...openDocIds].map((docId) => {
      const doc = documents.find((row) => row.docId === docId);
      const links = linksByDoc.get(docId) ?? [];
      return {
        docId,
        title: doc?.title ?? '(inconnu)',
        seq: doc?.seq ?? 0,
        readers: connections.items.filter((row) => row.docId === docId).length,
        links: links.map((link) => ({
          token: link.token,
          status: link.status,
          remaining: link.remaining,
          maxDownloads: link.maxDownloads,
        })),
      };
    }),
    activeLinks: [...linksByDoc.values()].flat().filter((link) => link.status === 'ACTIVE').length,
    creditToday: credits.items
      .filter((row) => row.day === today)
      .map((row) => ({ email: row.email, used: row.used, limit: row.limit })),
    blocked: abuse.items
      .filter((row) => row.blockedUntil && new Date(row.blockedUntil).getTime() > now)
      .map((row) => ({ email: row.email, blockedUntil: row.blockedUntil, refusals: row.refusals })),
  });
}
