/**
 * Preuve de C4 : un rédacteur n'écrit jamais plus que son crédit du jour,
 * même depuis plusieurs appareils, et un update rejoué n'est débité qu'une fois.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MemoryDynamo } from './helpers/memory-dynamo';
import { resetConfigCache } from '../src/lib/config';
import { setDdbClient } from '../src/lib/db';
import { commitUpdate } from '../src/lib/updates';
import { getCredit } from '../src/lib/credits';
import { ApiError } from '../src/lib/errors';
import type { CreditRow } from '../src/lib/types';

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

function setup(creditPerDay = 10000): void {
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
    docId: 'doc_credit',
    title: 'Brouillon',
    ownerEmail: 'auteur@exemple.cm',
    ownerName: 'Auteur',
    seq: 0,
    latestSnapshotSeq: 0,
    textLength: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
  process.env.CREDIT_PER_DAY = String(creditPerDay);

  resetConfigCache();
  setDdbClient(memory.client());
}

/** Produit un update Yjs contenant `length` caractères. */
function makeUpdate(text: string): { update: Uint8Array; doc: Y.Doc } {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  doc.getText('content').insert(0, text);
  return { update: updates[updates.length - 1], doc };
}

describe('C4 — crédit d\'écriture', () => {
  beforeEach(() => setup(10000));

  it('débite exactement le nombre de caractères insérés', async () => {
    const { update } = makeUpdate('bonjour');
    const result = await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_1',
      payload: update,
    });
    expect(result.chars).toBe(7);
    expect(result.seq).toBe(1);

    const credit = await getCredit('auteur@exemple.cm');
    expect(credit.used).toBe(7);
    expect(credit.remaining).toBe(9993);
  });

  it('refuse au-delà du plafond et ne persiste rien', async () => {
    const limit = 20;
    setup(limit);
    const first = makeUpdate('abcdefghij'); // 10 caractères
    await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_a',
      payload: first.update,
    });

    const tooBig = makeUpdate('klmnopqrstuvwxyz'); // 16 caractères → dépasse
    await expect(
      commitUpdate({
        docId: 'doc_credit',
        authorEmail: 'auteur@exemple.cm',
        authorName: 'Auteur',
        opId: 'op_b',
        payload: tooBig.update,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const credit = await getCredit('auteur@exemple.cm');
    expect(credit.used).toBe(10);
    const doc = memory.get(TABLES.DOCUMENTS, { docId: 'doc_credit' }) as { seq: number };
    expect(doc.seq).toBe(1);
    expect(memory.count(TABLES.UPDATES)).toBe(1);
  });

  it('accepte exactement jusqu\'au plafond, pas un caractère de plus', async () => {
    setup(10);
    const exact = makeUpdate('abcdefghij');
    await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_exact',
      payload: exact.update,
    });

    const extra = makeUpdate('k');
    await expect(
      commitUpdate({
        docId: 'doc_credit',
        authorEmail: 'auteur@exemple.cm',
        authorName: 'Auteur',
        opId: 'op_extra',
        payload: extra.update,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const credit = await getCredit('auteur@exemple.cm');
    expect(credit.used).toBe(10);
    expect(credit.remaining).toBe(0);
  });

  it('partage le compteur entre plusieurs appareils (même e-mail)', async () => {
    setup(30);
    const appareilA = makeUpdate('aaaaaaaaaa');
    const appareilB = makeUpdate('bbbbbbbbbb');
    const appareilC = makeUpdate('cccccccccccccccccccc'); // 20 → au-delà de 30

    await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_appareil_a',
      payload: appareilA.update,
    });
    await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_appareil_b',
      payload: appareilB.update,
    });

    await expect(
      commitUpdate({
        docId: 'doc_credit',
        authorEmail: 'auteur@exemple.cm',
        authorName: 'Auteur',
        opId: 'op_appareil_c',
        payload: appareilC.update,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const credit = await getCredit('auteur@exemple.cm');
    expect(credit.used).toBe(20);
    expect(memory.count(TABLES.CREDITS)).toBe(1);
  });

  it('rejoue le même opId sans débiter une seconde fois', async () => {
    const { update } = makeUpdate('douze lettres');
    const first = await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_retry',
      payload: update,
    });
    const second = await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_retry',
      payload: update,
    });

    expect(second.duplicate).toBe(true);
    expect(second.seq).toBe(first.seq);
    expect((await getCredit('auteur@exemple.cm')).used).toBe(13);
    expect(memory.count(TABLES.UPDATES)).toBe(1);
  });

  it('rejette un opId réutilisé avec un contenu différent', async () => {
    const first = makeUpdate('contenu un');
    await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_collision',
      payload: first.update,
    });

    const second = makeUpdate('contenu deux');
    await expect(
      commitUpdate({
        docId: 'doc_credit',
        authorEmail: 'auteur@exemple.cm',
        authorName: 'Auteur',
        opId: 'op_collision',
        payload: second.update,
      }),
    ).rejects.toMatchObject({ code: 'OP_ID_CONFLICT' });
  });

  it('reconnaît le même contenu présenté sous un autre opId', async () => {
    const { update } = makeUpdate('identique');
    const first = await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_original',
      payload: update,
    });
    const second = await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_autre',
      payload: update,
    });

    expect(second.duplicate).toBe(true);
    expect(second.seq).toBe(first.seq);
    expect((await getCredit('auteur@exemple.cm')).used).toBe(9);
  });

  it('facture aussi les suppressions', async () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'abcdefghij');
    const updates: Uint8Array[] = [];
    doc.on('update', (update: Uint8Array) => updates.push(update));
    text.delete(2, 4); // 4 caractères supprimés

    const result = await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_delete',
      payload: updates[updates.length - 1],
    });

    expect(result.deleted).toBe(4);
    expect(result.chars).toBe(4);
    expect((await getCredit('auteur@exemple.cm')).used).toBe(4);
  });

  it('garde une séquence contiguë, sans trou', async () => {
    for (let index = 0; index < 8; index++) {
      const { update } = makeUpdate(`bloc ${index}`);
      await commitUpdate({
        docId: 'doc_credit',
        authorEmail: 'auteur@exemple.cm',
        authorName: 'Auteur',
        opId: `op_seq_${index}`,
        payload: update,
      });
    }
    const updates = memory.all(TABLES.UPDATES).map((row) => Number(row.seq)).sort((a, b) => a - b);
    expect(updates).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const doc = memory.get(TABLES.DOCUMENTS, { docId: 'doc_credit' }) as { seq: number };
    expect(doc.seq).toBe(8);
  });

  it('ne débite pas la restauration de version (update système)', async () => {
    const { update } = makeUpdate('texte initial');
    await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_initial',
      payload: update,
    });
    const before = (await getCredit('auteur@exemple.cm')).used;

    const restore = makeUpdate('texte restauré');
    await commitUpdate({
      docId: 'doc_credit',
      authorEmail: 'auteur@exemple.cm',
      authorName: 'Auteur',
      opId: 'op_restore',
      payload: restore.update,
      chargeCredit: false,
    });

    const after = (await getCredit('auteur@exemple.cm')).used;
    expect(after).toBe(before);
  });

  it('bloque l\'écriture après 4 refus dans la journée', async () => {
    setup(5);
    const { update } = makeUpdate('trop long');
    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect(
        commitUpdate({
          docId: 'doc_credit',
          authorEmail: 'auteur@exemple.cm',
          authorName: 'Auteur',
          opId: `op_refus_${attempt}`,
          payload: update,
        }),
      ).rejects.toBeInstanceOf(ApiError);
    }

    await expect(
      commitUpdate({
        docId: 'doc_credit',
        authorEmail: 'auteur@exemple.cm',
        authorName: 'Auteur',
        opId: 'op_apres_blocage',
        payload: update,
      }),
    ).rejects.toMatchObject({ code: 'BLOCKED' });

    const creditRow = memory.get(TABLES.CREDITS, { id: `${'auteur@exemple.cm'}#${new Date().toISOString().slice(0, 10)}` }) as CreditRow | undefined;
    expect(creditRow?.used ?? 0).toBe(0);
  });
});
