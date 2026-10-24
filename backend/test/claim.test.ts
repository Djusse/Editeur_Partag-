/**
 * Preuve de C1 : un lien distribue **exactement** N exemplaires, jamais N+1,
 * sous concurrence et en cas de retry du même visiteur.
 *
 * Preuve de la correction 4.2-1 du plan v7 : le ticket d'un visiteur est
 * cherché **avant** le court-circuit `exhausted`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { claim, createLink, file, linkStatus, setLastSeqReader, validateVisitorId } from '../src/lib/links';
import { setupHarness, seedDocument, type Harness } from './helpers/setup';
import { manager } from '../src/realtime/manager';
import type { LinkRow, TicketRow } from '../src/lib/types';

let harness: Harness;

beforeEach(async () => {
  harness = setupHarness();
  await seedDocument(harness.memory);
  // Le hub n'est pas sollicité ici : on fixe la version courante du document.
  setLastSeqReader(async () => 42);
});

async function makeLink(maxDownloads: number): Promise<LinkRow> {
  return createLink({
    docId: 'doc_test',
    docTitle: 'Journal 2026',
    maxDownloads,
    createdByEmail: 'owner@exemple.cm',
    createdByName: 'Propriétaire',
  });
}

describe('C1 — exactement N téléchargements', () => {
  it('accorde N exemplaires puis refuse le suivant', async () => {
    const link = await makeLink(10);

    for (let index = 0; index < 10; index++) {
      const result = await claim(link.token, `visiteur_${index}_abcdef`);
      expect(result.status).toBe(202); // PDF en préparation (premier passage)
      expect(result.body.state).toBe('waiting');
    }

    const extra = await claim(link.token, 'visiteur_final_abcde');
    expect(extra.status).toBe(410);
    expect(extra.body).toEqual({ state: 'exhausted' });

    const stored = harness.memory.peek<LinkRow>('Links', { token: link.token })!;
    expect(stored.remaining).toBe(0);
    expect(stored.status).toBe('EXHAUSTED');
    expect(harness.memory.count('Tickets')).toBe(10);
  });

  it('ne consomme jamais deux exemplaires pour le même visiteur', async () => {
    const link = await makeLink(3);

    await claim(link.token, 'visiteur_retry_abc');
    await claim(link.token, 'visiteur_retry_abc');

    const stored = harness.memory.peek<LinkRow>('Links', { token: link.token })!;
    expect(stored.remaining).toBe(2);
    expect(harness.memory.count('Tickets')).toBe(1);
  });

  it('renvoie le ticket existant même après épuisement (correction 4.2-1)', async () => {
    const link = await makeLink(1);
    await claim(link.token, 'visiteur_unique_abc');
    expect(harness.memory.peek<LinkRow>('Links', { token: link.token })!.status).toBe('EXHAUSTED');

    const apres = await claim(link.token, 'visiteur_unique_abc');
    // `waiting` (PDF en cours) ou `ready` : jamais `exhausted`.
    expect(apres.status).not.toBe(410);

    const autre = await claim(link.token, 'visiteur_autre_abcd');
    expect(autre.status).toBe(410);
  });

  it('reste exact sous concurrence forte (50 claims simultanés pour N=20)', async () => {
    const link = await makeLink(20);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => claim(link.token, `concurrent_${index}_xxxxx`)),
    );

    // Tout le monde reçoit un état explicite : jamais d'erreur brute.
    const valid = results.filter((result) => [200, 202, 410].includes(result.status));
    expect(valid.length).toBe(50);

    // Le compteur fait foi : exactement 20 tickets, jamais 21.
    expect(harness.memory.count('Tickets')).toBe(20);

    const stored = harness.memory.peek<LinkRow>('Links', { token: link.token })!;
    expect(stored.remaining).toBe(0);
    expect(stored.status).toBe('EXHAUSTED');
  });

  it('fige la version du document au moment du claim (T1)', async () => {
    const link = await makeLink(5);
    await claim(link.token, 'visiteur_t1_abcdef');

    const ticket = harness.memory.rows<TicketRow>('Tickets')[0];
    expect(ticket.seqFrozen).toBe(42);
  });

  it('refuse un identifiant de visiteur trop court', async () => {
    const link = await makeLink(5);
    // La validation est faite par la route (`validateVisitorId`), pas par le
    // service : elle doit être testée là où elle est branchée.
    expect(() => validateVisitorId('abc')).toThrow();
    expect(() => validateVisitorId('visiteur_valide_123')).not.toThrow();
  });

  it('expose un état public cohérent (titre + statut)', async () => {
    const link = await makeLink(2);

    const initial = await linkStatus(link.token);
    expect(initial.status).toBe('active');
    expect(initial.title).toBe('Journal 2026');
    expect(initial.remaining).toBe(2);

    await claim(link.token, 'visiteur_status_abc');
    await claim(link.token, 'visiteur_status_def');

    const final = await linkStatus(link.token);
    expect(final.status).toBe('exhausted');
    expect(final.remaining).toBe(0);
  });

  it('ne crée aucun ticket pour un lien inconnu', async () => {
    await expect(claim('token_inexistant', 'visiteur_abc_123')).rejects.toThrow();
    expect(harness.memory.count('Tickets')).toBe(0);
  });

  it('GET /file refuse un visiteur sans ticket', async () => {
    const link = await makeLink(5);
    await expect(file(link.token, 'visiteur_sans_ticket')).rejects.toMatchObject({ status: 410 });
  });

  it('enregistre le job PDF une seule fois pour une version donnée', async () => {
    const link = await makeLink(5);
    await claim(link.token, 'visiteur_pdf_abcde');
    await claim(link.token, 'visiteur_pdf_fghij');

    // Même `seqFrozen` : un seul message, donc une seule génération.
    expect(harness.jobs.length).toBe(1);
    expect(harness.jobs[0].seq).toBe(42);
  });
});

describe('C1 — après génération du PDF', () => {
  it('sert une URL quand le cache est READY, sans consommer d’exemplaire', async () => {
    const link = await makeLink(2);
    await claim(link.token, 'visiteur_cache_abc');

    // Simule la fin de génération par le worker.
    await harness.memory.update('PdfCache', { id: 'doc_test#42' }, {
      update: 'SET #status = :ready, s3Key = :key',
      names: { '#status': 'status' },
      values: { ':ready': 'READY', ':key': 'pdf/doc_test/v42.pdf' },
    });

    const again = await claim(link.token, 'visiteur_cache_abc');
    expect(again.status).toBe(200);
    expect(again.body.state).toBe('ready');

    const stored = harness.memory.peek<LinkRow>('Links', { token: link.token })!;
    expect(stored.remaining).toBe(1);

    manager.stop();
  });
});
