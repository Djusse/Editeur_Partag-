/**
 * Preuve de C4 : un rédacteur n'écrit jamais plus que son crédit du jour,
 * même depuis plusieurs appareils, et un update rejoué n'est débité qu'une fois.
 *
 * Les tests passent par `commitBatch`, chemin **identique** au WebSocket et au
 * repli HTTP : c'est le même code qui décide du débit.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { commitBatch, hashOf, type Client, type IncomingUpdate } from '../src/realtime/hub';
import { setDatabase } from '../src/lib/db';
import { setupHarness, seedDocument, teardownHarness, type Harness } from './helpers/setup';
import { resetConfigCache } from '../src/lib/config';
import { MemoryDatabase } from './helpers/memory-db';
import { getCreditState } from '../src/lib/credits';
import type { CreditRow } from '../src/lib/types';

let harness: Harness;

/** Crée un client factice (aucune vraie connexion réseau). */
function makeClient(email: string, docId = 'doc_test'): Client {
  return {
    id: `c_${Math.random().toString(16).slice(2)}`,
    socket: { readyState: 1, send: () => undefined } as never,
    email,
    name: email.split('@')[0],
    color: '#2563EB',
    docId,
    seq: 0,
    cursor: null,
  };
}

/** Produit un update Yjs contenant exactement `length` caractères. */
function updateOf(text: string): Uint8Array {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  doc.getText('content').insert(0, text);
  return updates[updates.length - 1];
}

function incoming(client: Client, opId: string, text: string): IncomingUpdate {
  const payload = updateOf(text);
  return {
    client,
    opId,
    payload,
    chars: text.length,
    inserted: text.length,
    deleted: 0,
    hash: hashOf(payload),
  };
}

async function state(docId = 'doc_test') {
  const { manager } = await import('../src/realtime/manager');
  return manager.load(docId);
}

describe('C4 — crédit d’écriture', () => {
  beforeEach(async () => {
    harness = setupHarness();
    await seedDocument(harness.memory);
  });

  it('débite exactement le nombre de caractères insérés', async () => {
    const doc = await state();
    await commitBatch(doc, [incoming(makeClient('auteur@exemple.cm'), 'op_1', 'bonjour')]);

    const credit = await getCreditState('auteur@exemple.cm');
    expect(credit.used).toBe(7);
    expect(credit.remaining).toBe(9993);
    expect(doc.seq).toBe(1);
  });

  it('refuse au-delà du plafond sans rien persister', async () => {
    harness = setupHarness({ creditPerDay: 20 });
    await seedDocument(harness.memory);
    resetConfigCache();
    const { manager } = await import('../src/realtime/manager');
    manager.stop();

    const doc = await manager.load('doc_test');
    await commitBatch(doc, [incoming(makeClient('auteur@exemple.cm'), 'op_a', 'abcdefghij')]);

    const before = doc.seq;
    await commitBatch(doc, [incoming(makeClient('auteur@exemple.cm'), 'op_b', 'klmnopqrstuvwxyz')]);

    const credit = await getCreditState('auteur@exemple.cm');
    expect(credit.used).toBe(10);
    expect(doc.seq).toBe(before);
  });

  it('accepte exactement jusqu’au plafond, pas un caractère de plus', async () => {
    harness = setupHarness({ creditPerDay: 10 });
    await seedDocument(harness.memory);
    resetConfigCache();
    const { manager } = await import('../src/realtime/manager');
    manager.stop();

    const doc = await manager.load('doc_test');
    await commitBatch(doc, [incoming(makeClient('auteur@exemple.cm'), 'op_exact', 'abcdefghij')]);
    expect((await getCreditState('auteur@exemple.cm')).remaining).toBe(0);

    const seqBefore = doc.seq;
    await commitBatch(doc, [incoming(makeClient('auteur@exemple.cm'), 'op_extra', 'k')]);

    expect((await getCreditState('auteur@exemple.cm')).used).toBe(10);
    expect(doc.seq).toBe(seqBefore);
  });

  it('partage le compteur entre plusieurs connexions (même e-mail)', async () => {
    harness = setupHarness({ creditPerDay: 30 });
    await seedDocument(harness.memory);
    resetConfigCache();
    const { manager } = await import('../src/realtime/manager');
    manager.stop();

    const doc = await manager.load('doc_test');
    const appareilA = makeClient('auteur@exemple.cm');
    const appareilB = makeClient('auteur@exemple.cm');

    await commitBatch(doc, [incoming(appareilA, 'op_a', 'aaaaaaaaaa')]);
    await commitBatch(doc, [incoming(appareilB, 'op_b', 'bbbbbbbbbb')]);

    const credit = await getCreditState('auteur@exemple.cm');
    expect(credit.used).toBe(20);
    expect(harness.memory.rows<CreditRow>('Credits').length).toBe(1);
  });

  it('rejoue le même opId sans débiter une seconde fois', async () => {
    const doc = await state();
    const client = makeClient('auteur@exemple.cm');
    const update = incoming(client, 'op_retry', 'douze lettres');

    await commitBatch(doc, [update]);
    await commitBatch(doc, [update]);

    const credit = await getCreditState('auteur@exemple.cm');
    expect(credit.used).toBe(13);
    expect(doc.seq).toBe(1);
  });

  it('reconnaît le même contenu présenté sous un autre opId', async () => {
    const doc = await state();
    const client = makeClient('auteur@exemple.cm');
    const first = incoming(client, 'op_original', 'identique');

    await commitBatch(doc, [first]);
    await commitBatch(doc, [{ ...first, opId: 'op_autre' }]);

    expect((await getCreditState('auteur@exemple.cm')).used).toBe(9);
    expect(doc.seq).toBe(1);
  });

  it('facture aussi les suppressions', async () => {
    const client = makeClient('auteur@exemple.cm');
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'abcdefghij');

    const update = await state();
    const base = incoming(client, 'op_insert', 'abcdefghij');
    await commitBatch(update, [base]);

    const deletions: Uint8Array[] = [];
    doc.on('update', (value: Uint8Array) => deletions.push(value));
    text.delete(2, 4);
    const payload = deletions[deletions.length - 1];

    await commitBatch(update, [
      { client, opId: 'op_delete', payload, chars: 4, inserted: 0, deleted: 4, hash: hashOf(payload) },
    ]);

    // 10 insertions + 4 suppressions
    expect((await getCreditState('auteur@exemple.cm')).used).toBe(14);
  });

  it('garde une séquence contiguë, sans trou', async () => {
    const doc = await state();
    const client = makeClient('auteur@exemple.cm');

    for (let index = 0; index < 8; index++) {
      await commitBatch(doc, [incoming(client, `op_seq_${index}`, `bloc ${index}`)]);
    }

    const rows = harness.memory.rows<{ seq: number }>('Updates').map((row) => row.seq).sort((a, b) => a - b);
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(doc.seq).toBe(8);
  });

  it('ne débite pas un update à crédit nul (update système)', async () => {
    const doc = await state();
    const client = makeClient('auteur@exemple.cm');

    await commitBatch(doc, [incoming(client, 'op_initial', 'texte initial')]);
    const before = (await getCreditState('auteur@exemple.cm')).used;

    const payload = updateOf('texte restauré');
    await commitBatch(doc, [
      { client, opId: 'op_restore', payload, chars: 0, inserted: 0, deleted: 0, hash: hashOf(payload) },
    ]);

    expect((await getCreditState('auteur@exemple.cm')).used).toBe(before);
    expect(doc.seq).toBe(2);
  });

  it('bloque l’écriture après 4 refus dans la journée', async () => {
    harness = setupHarness({ creditPerDay: 5, blockAfterRefusals: 4 });
    await seedDocument(harness.memory);
    resetConfigCache();
    const { manager } = await import('../src/realtime/manager');
    manager.stop();

    const doc = await manager.load('doc_test');
    const client = makeClient('auteur@exemple.cm');

    for (let attempt = 1; attempt <= 4; attempt++) {
      await commitBatch(doc, [incoming(client, `op_refus_${attempt}`, 'trop long pour le crédit')]);
    }

    const credit = await getCreditState('auteur@exemple.cm');
    expect(credit.used).toBe(0);
    expect(credit.blockedUntil).not.toBeNull();
  });

  it('un refus ne bloque pas les autres rédacteurs du même lot', async () => {
    harness = setupHarness({ creditPerDay: 10 });
    await seedDocument(harness.memory);
    resetConfigCache();
    const { manager } = await import('../src/realtime/manager');
    manager.stop();

    const doc = await manager.load('doc_test');
    const pauvre = makeClient('pauvre@exemple.cm');
    const riche = makeClient('riche@exemple.cm');

    // Le pauvre dépasse le plafond, le riche non : seul le pauvre est refusé.
    await commitBatch(doc, [
      incoming(pauvre, 'op_pauvre', 'abcdefghijklmnopqrstuvwxyz'),
      incoming(riche, 'op_riche', 'court'),
    ]);

    expect((await getCreditState('riche@exemple.cm')).used).toBe(5);
    expect((await getCreditState('pauvre@exemple.cm')).used).toBe(0);
    expect(doc.seq).toBe(1);
  });
});
