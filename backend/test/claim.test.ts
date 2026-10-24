/**
 * Preuve de C1 : un lien distribue exactement N exemplaires, jamais N+1,
 * y compris sous concurrence et en cas de retry du même visiteur.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDynamo } from './helpers/memory-dynamo';
import { resetConfigCache } from '../src/lib/config';
import { setDdbClient } from '../src/lib/db';
import { claimDownload, createLink, linkStatus } from '../src/lib/links';
import { setPresignerOverride } from '../src/lib/s3';
import type { LinkRow, TicketRow } from '../src/lib/types';

const TABLES = {
  DOCUMENTS: 'Documents',
  MEMBERS: 'Members',
  UPDATES: 'Updates',
  CONNECTIONS: 'Connections',
  CREDITS: 'Credits',
  OPIDS: 'OpIds',
  ABUSE: 'Abuse',
  LINKS: 'Links',
  TICKETS: 'Tickets',
  WSTICKETS: 'WsTickets',
  PDFCACHE: 'PdfCache',
  VERSIONS: 'Versions',
};

let memory: MemoryDynamo;

function setup(): void {
  memory = new MemoryDynamo();
  memory.createTable(TABLES.DOCUMENTS, ['docId']);
  memory.createTable(TABLES.MEMBERS, ['docId', 'email']);
  memory.createTable(TABLES.UPDATES, ['docId', 'seq']);
  memory.createTable(TABLES.CONNECTIONS, ['connectionId']);
  memory.createTable(TABLES.CREDITS, ['id']);
  memory.createTable(TABLES.OPIDS, ['id']);
  memory.createTable(TABLES.ABUSE, ['id']);
  memory.createTable(TABLES.LINKS, ['token']);
  memory.createTable(TABLES.TICKETS, ['token', 'visitorId']);
  memory.createTable(TABLES.WSTICKETS, ['ticket']);
  memory.createTable(TABLES.PDFCACHE, ['id']);
  memory.createTable(TABLES.VERSIONS, ['docId', 'n']);

  memory.put(TABLES.DOCUMENTS, {
    docId: 'doc_test',
    title: 'Journal 2026',
    ownerEmail: 'owner@exemple.cm',
    ownerName: 'Propriétaire',
    seq: 42,
    latestSnapshotSeq: 0,
    textLength: 120,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Le PDF est considéré déjà prêt pour isoler la logique de réservation.
  memory.put(TABLES.PDFCACHE, {
    id: 'doc_test#42',
    docId: 'doc_test',
    seq: 42,
    status: 'READY',
    s3Key: 'pdf/doc_test/v42.pdf',
    createdAt: new Date().toISOString(),
    ttl: 9999999999,
  });

  process.env.DOCUMENTS_TABLE = TABLES.DOCUMENTS;
  process.env.MEMBERS_TABLE = TABLES.MEMBERS;
  process.env.UPDATES_TABLE = TABLES.UPDATES;
  process.env.CONNECTIONS_TABLE = TABLES.CONNECTIONS;
  process.env.CREDITS_TABLE = TABLES.CREDITS;
  process.env.OPIDS_TABLE = TABLES.OPIDS;
  process.env.ABUSE_TABLE = TABLES.ABUSE;
  process.env.LINKS_TABLE = TABLES.LINKS;
  process.env.TICKETS_TABLE = TABLES.TICKETS;
  process.env.WSTICKETS_TABLE = TABLES.WSTICKETS;
  process.env.PDFCACHE_TABLE = TABLES.PDFCACHE;
  process.env.VERSIONS_TABLE = TABLES.VERSIONS;
  process.env.PDF_BUCKET = 'bucket-test';
  process.env.JWT_SECRET_PARAM = '/test/jwt';
  process.env.ADMIN_KEY_PARAM = '/test/admin';
  process.env.SES_SENDER = 'noreply@exemple.cm';
  process.env.AWS_REGION = 'eu-west-3';

  resetConfigCache();
  setDdbClient(memory.client());
  // Aucun appel AWS : l'URL présignée est simulée pour isoler la logique de quota.
  setPresignerOverride(async (key, filename) => `https://exemple.invalid/${key}?file=${filename}`);
}

async function seedLink(maxDownloads: number): Promise<LinkRow> {
  return createLink({
    docId: 'doc_test',
    maxDownloads,
    createdByEmail: 'owner@exemple.cm',
    createdByName: 'Propriétaire',
  });
}

describe('C1 — exactement N téléchargements', () => {
  beforeEach(setup);

  it('accorde N exemplaires puis refuse le suivant', async () => {
    const link = await seedLink(10);
    for (let index = 0; index < 10; index++) {
      const result = await claimDownload(link.token, `visiteur_${index}_abcdef`);
      expect(result.state).toBe('ready');
    }
    const extra = await claimDownload(link.token, 'visiteur_final_abcdef');
    expect(extra.state).toBe('exhausted');
    expect(extra.status).toBe(410);

    const stored = memory.get(TABLES.LINKS, { token: link.token }) as unknown as LinkRow;
    expect(stored.remaining).toBe(0);
    expect(stored.status).toBe('EXHAUSTED');
    expect(memory.count(TABLES.TICKETS)).toBe(10);
  });

  it('ne consomme jamais deux exemplaires pour le même visiteur (retry)', async () => {
    const link = await seedLink(3);
    const first = await claimDownload(link.token, 'visiteur_retry_abc');
    const second = await claimDownload(link.token, 'visiteur_retry_abc');
    expect(first.state).toBe('ready');
    expect(second.state).toBe('ready');

    const stored = memory.get(TABLES.LINKS, { token: link.token }) as unknown as LinkRow;
    expect(stored.remaining).toBe(2);
    expect(memory.count(TABLES.TICKETS)).toBe(1);
  });

  it('renvoie le ticket existant même après épuisement', async () => {
    const link = await seedLink(1);
    const first = await claimDownload(link.token, 'visiteur_unique_abc');
    expect(first.state).toBe('ready');

    const afterExhaustion = await claimDownload(link.token, 'visiteur_unique_abc');
    expect(afterExhaustion.state).toBe('ready');
    expect(afterExhaustion.seqFrozen).toBe(42);

    const autre = await claimDownload(link.token, 'visiteur_autre_abcd');
    expect(autre.state).toBe('exhausted');
  });

  it('reste exact sous concurrence forte (50 claims simultanés pour N=20)', async () => {
    const link = await seedLink(20);
    const attempts = Array.from({ length: 50 }, (_, index) => claimDownload(link.token, `concurrent_${index}_xxxx`));
    const results = await Promise.all(attempts);

    const ready = results.filter((result) => result.state === 'ready');
    const exhausted = results.filter((result) => result.state === 'exhausted');
    const waiting = results.filter((result) => result.state === 'waiting');

    expect(ready.length).toBe(20);
    expect(ready.length + exhausted.length + waiting.length).toBe(50);
    // Aucun visiteur n'est "jeté" : tout le monde reçoit un état explicite.
    expect(memory.count(TABLES.TICKETS)).toBe(20);

    const stored = memory.get(TABLES.LINKS, { token: link.token }) as unknown as LinkRow;
    expect(stored.remaining).toBe(0);
    expect(stored.status).toBe('EXHAUSTED');
  });

  it('fige la version du document au moment du claim (T1)', async () => {
    const link = await seedLink(5);
    await claimDownload(link.token, 'visiteur_t1_abcdef');

    // Le document continue d'évoluer après le claim.
    memory.update(TABLES.DOCUMENTS, { docId: 'doc_test' }, { seq: 99 });

    const ticket = [...memory.all(TABLES.TICKETS)][0] as unknown as TicketRow;
    expect(ticket.seqFrozen).toBe(42);
  });

  it('refuse un visiteur sans identifiant valide', async () => {
    const link = await seedLink(5);
    await expect(claimDownload(link.token, 'abc')).rejects.toThrow();
  });

  it('expose un état public cohérent', async () => {
    const link = await seedLink(2);
    const initial = await linkStatus(link.token);
    expect(initial.status).toBe('active');
    expect(initial.remaining).toBe(2);

    await claimDownload(link.token, 'visiteur_status_abc');
    await claimDownload(link.token, 'visiteur_status_def');

    const final = await linkStatus(link.token);
    expect(final.status).toBe('exhausted');
    expect(final.remaining).toBe(0);
  });

  it('ne crée aucun ticket pour un lien inconnu', async () => {
    await expect(claimDownload('token_inexistant', 'visiteur_abc_123')).rejects.toThrow();
    expect(memory.count(TABLES.TICKETS)).toBe(0);
  });
});
