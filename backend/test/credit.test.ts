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
import { nextUtcMidnight, secondsUntilUtcMidnight, utcDay } from '../src/lib/ids';
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

  it('remet le crédit à zéro à minuit heure de Douala, pas à minuit UTC', () => {
    // 22:59 UTC = 23:59 à Douala : encore le même jour métier.
    const before = new Date('2026-10-25T22:59:00.000Z');
    // 23:00 UTC = 00:00 à Douala le lendemain : le jour métier a changé.
    const after = new Date('2026-10-25T23:00:00.000Z');

    expect(utcDay(before)).toBe('2026-10-25');
    expect(utcDay(after)).toBe('2026-10-26');

    // Le lendemain de `before` commence bien à 23:00 UTC (minuit local).
    expect(nextUtcMidnight(before).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(secondsUntilUtcMidnight(before)).toBe(60);
  });

  it('annonce une recharge à 23:00 UTC, soit minuit à Douala', async () => {
    const credit = await getCreditState('auteur@exemple.cm');
    expect(new Date(credit.resetsAt).getUTCHours()).toBe(23);
    expect(new Date(credit.resetsAt).getUTCMinutes()).toBe(0);
  });

  it('débite exactement le nombre de caractères insérés', async () => {
    const doc = await state();
    await commitBatch(doc, [incoming(makeClient('auteur@exemple.cm'), 'op_1', 'bonjour')]);

    const credit = await getCreditState('auteur@exemple.cm');
    expect(credit.used).toBe(7);
    expect(credit.remaining).toBe(9993);
    expect(doc.seq).toBe(1);
  });

  it('n’utilise aucune arithmétique entre valeurs dans une ConditionExpression', async () => {
    // Régression : `used + :chars <= :limit` levait en production
    //   ValidationException: Invalid ConditionExpression:
    //   Syntax error; token: "+", near: "used + :chars"
    // Le double en mémoire évaluait lui-même cette expression, donc les tests
    // restaient verts alors qu'aucun update n'était persisté. Le helper lève
    // désormais, et l'on vérifie ici que le débit fonctionne toujours.
    const doc = await state();
    const client = makeClient('auteur@exemple.cm');

    await commitBatch(doc, [incoming(client, 'op_no_arith', 'bonjour')]);

    const credit = await getCreditState('auteur@exemple.cm');
    expect(credit.used).toBe(7);
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

  it('refuse encore l’écriture une fois bloqué, sans rien persister', async () => {
    // Régression : `assertNotBlocked` n'était vérifié qu'à l'entrée du
    // WebSocket. Un lot franchissant la limite de refus pendant son traitement
    // laissait passer l'update suivant : il était acquitté et facturé alors que
    // l'écriture était déjà suspendue, et l'interface ne signalait plus rien.
    harness = setupHarness({ creditPerDay: 5, blockAfterRefusals: 2 });
    await seedDocument(harness.memory);
    resetConfigCache();
    const { manager } = await import('../src/realtime/manager');
    manager.stop();

    const doc = await manager.load('doc_test');
    const client = makeClient('auteur@exemple.cm');

    // Deux refus suffisent ici à déclencher le blocage.
    const first = await commitBatch(doc, [incoming(client, 'op_refus_1', 'trop long pour le credit')]);
    const second = await commitBatch(doc, [incoming(client, 'op_refus_2', 'trop long pour le credit')]);
    expect(first[0]?.code).toBe('CREDIT_EXHAUSTED');
    expect(second[0]?.code).toBe('BLOCKED');
    expect(second[0]?.blockedUntil).toBeTruthy();

    const seqBefore = doc.seq;

    // Maintenant bloqué : même un update minuscule doit être refusé.
    const after = await commitBatch(doc, [incoming(client, 'op_apres_blocage', 'a')]);

    expect(after).toHaveLength(1);
    expect(after[0].code).toBe('BLOCKED');
    expect(after[0].email).toBe('auteur@exemple.cm');
    expect(doc.seq).toBe(seqBefore);
    expect(harness.memory.rows('Updates').length).toBe(0);
  });

  it('laisse passer un update système malgré le blocage (restauration gratuite)', async () => {
    // La nouvelle garde de blocage ne doit pas empêcher la restauration d'une
    // version, explicitement gratuite dans la spécification.
    harness = setupHarness({ creditPerDay: 5, blockAfterRefusals: 2 });
    await seedDocument(harness.memory);
    resetConfigCache();
    const { manager } = await import('../src/realtime/manager');
    manager.stop();

    const doc = await manager.load('doc_test');
    const client = makeClient('auteur@exemple.cm');
    await commitBatch(doc, [incoming(client, 'op_r1', 'trop long pour le credit')]);
    await commitBatch(doc, [incoming(client, 'op_r2', 'trop long pour le credit')]);
    expect((await getCreditState('auteur@exemple.cm')).blockedUntil).not.toBeNull();

    const seqBefore = doc.seq;
    const payload = updateOf('texte restauré');
    const systemClient = { ...client, system: true };
    const result = await commitBatch(doc, [
      { client: systemClient, opId: 'op_restore', payload, chars: 0, inserted: 0, deleted: 0, hash: hashOf(payload) },
    ]);

    expect(result).toHaveLength(0);
    expect(doc.seq).toBe(seqBefore + 1);
    expect((await getCreditState('auteur@exemple.cm')).used).toBe(0);
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

  /**
   * Un update écarté comme doublon **interne** au lot doit tout de même être
   * acquitté.
   *
   * Défaut observé en charge le 26/10 : 2 292 updates émis par 50 rédacteurs,
   * 106 acquittés, 50 diffusés, 0 erreur. Le `continue` muet qui retirait les
   * doublons d'empreinte laissait leurs expéditeurs sans réponse, et l'interface
   * restait bloquée sur « N modifications en attente ».
   *
   * Ce test reproduit la cause exacte : deux clients envoient le **même**
   * contenu, donc la même empreinte, dans le même lot. Les deux doivent
   * recevoir un `ack`, et le crédit ne doit être débité qu'une fois.
   */
  it('acquitte les doublons internes du lot au lieu de les laisser sans réponse', async () => {
    harness = setupHarness();
    await seedDocument(harness.memory);
    resetConfigCache();
    const { manager } = await import('../src/realtime/manager');
    manager.stop();

    const doc = await manager.load('doc_test');

    /**
     * Deux clients, **le même update binaire**.
     *
     * `incoming()` fabrique un `Y.Doc` neuf à chaque appel : l'identifiant de
     * client étant aléatoire, deux appels produisent deux binaires différents.
     * Ce ne serait donc pas des doublons, et le test ne prouverait rien — c'est
     * précisément l'erreur de la première version de ce test, qui échouait pour
     * cette raison.
     *
     * On construit donc un payload unique, partagé par les deux clients. C'est
     * exactement ce que faisait le scénario k6 avant correction : un seul
     * `UPDATE_B64` codé en dur pour tous les VUs.
     */
    const payload = updateOf('identique');
    const partage = (client: Client, opId: string): IncomingUpdate => ({
      client,
      opId,
      payload,
      chars: 9,
      inserted: 9,
      deleted: 0,
      hash: hashOf(payload),
    });

    const mises: string[] = [];
    const capture = (email: string): Client => ({
      ...makeClient(email),
      socket: {
        readyState: 1,
        send: (raw: string) => {
          const message = JSON.parse(raw) as { type?: string; opIds?: string[] };
          if (message.type === 'ack') mises.push(`${email}:${(message.opIds ?? []).join(',')}`);
        },
      } as never,
    });

    const a = capture('un@exemple.cm');
    const b = capture('deux@exemple.cm');

    await commitBatch(doc, [partage(a, 'op_a'), partage(b, 'op_b')]);

    // Les `ack` du chemin normal partent dans une IIFE non attendue
    // (`applyAndBroadcast`) : on laisse la boucle d'événements les délivrer.
    for (let essai = 0; essai < 40 && mises.length < 2; essai++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Le contenu n'est écrit qu'une fois…
    expect(doc.seq).toBe(1);
    // …et les deux expéditeurs sont acquittés, chacun avec son propre opId.
    expect(mises).toContain('un@exemple.cm:op_a');
    expect(mises).toContain('deux@exemple.cm:op_b');
    // Une seule empreinte écrite : le crédit n'est pas débité deux fois.
    expect((await getCreditState('un@exemple.cm')).used).toBe(9);
    expect((await getCreditState('deux@exemple.cm')).used).toBe(0);
  });
});
