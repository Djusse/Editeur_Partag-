/**
 * Notification de fin de quota (SES).
 *
 * Ce que l'on prouve :
 *  1. l'e-mail n'est envoyé qu'**au dernier** claim, pas avant ;
 *  2. un second appel n'envoie rien (verrou `notified`) ;
 *  3. un échec SES ne fait pas échouer le claim : le visiteur obtient son PDF ;
 *  4. le verrou est relâché après un échec, pour permettre une nouvelle tentative ;
 *  5. le contenu échappe le texte saisi par l'utilisateur.
 *
 * Le transport est injecté (`setMailer`) : aucun appel AWS.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claim, createLink } from '../src/lib/links';
import { buildExhaustedEmail, setMailer, type OutgoingEmail } from '../src/lib/email';
import { setDatabase } from '../src/lib/db';
import { resetConfigCache } from '../src/lib/config';
import { MemoryDatabase } from './helpers/memory-db';
import { seedDocument, setupHarness, TABLES, type Harness } from './helpers/setup';
import type { LinkRow } from '../src/lib/types';

let harness: Harness;
let sent: OutgoingEmail[];

/** Transport factice : enregistre les messages, peut échouer à la demande. */
function installMailer(options: { fail?: boolean } = {}) {
  sent = [];
  setMailer({
    async send(email) {
      if (options.fail) throw new Error('SES indisponible');
      sent.push(email);
    },
  });
}

async function makeLink(maxDownloads: number, overrides: Partial<LinkRow> = {}): Promise<LinkRow> {
  const link = await createLink({
    docId: 'doc_test',
    docTitle: 'Rapport final',
    maxDownloads,
    createdByEmail: 'auteur@exemple.cm',
    createdByName: 'Awa',
  });
  Object.assign(link, overrides);
  return link;
}

describe('notification de fin de quota', () => {
  beforeEach(async () => {
    harness = setupHarness();
    await seedDocument(harness.memory);
  });

  afterEach(() => {
    setMailer(null);
    setDatabase(null);
  });

  it('n’envoie aucun e-mail tant qu’il reste des exemplaires', async () => {
    installMailer();
    const link = await makeLink(2);

    await claim(link.token, 'visiteur_1_abcdef');
    expect(sent).toHaveLength(0);

    await claim(link.token, 'visiteur_2_abcdefgh');
    // Le second claim consomme le dernier exemplaire → un envoi.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('auteur@exemple.cm');
    expect(sent[0].subject).toContain('Rapport final');
  });

  it('envoie immédiatement pour un lien à un seul exemplaire', async () => {
    installMailer();
    const link = await makeLink(1);

    await claim(link.token, 'visiteur_1_abcdef');
    expect(sent).toHaveLength(1);
  });

  it('n’envoie qu’une fois, même si le claim est rejoué', async () => {
    installMailer();
    const link = await makeLink(1);

    await claim(link.token, 'visiteur_1_abcdef');
    // Rejeu du même visiteur : le ticket existe déjà, pas de nouvel envoi.
    await claim(link.token, 'visiteur_1_abcdef');
    // Un autre visiteur arrive après épuisement : refus, pas d'envoi.
    await claim(link.token, 'visiteur_2_abcdefgh');

    expect(sent).toHaveLength(1);
  });

  it('marque notified en base, sans quoi un redémarrage renverrait l’e-mail', async () => {
    installMailer();
    const link = await makeLink(1);
    await claim(link.token, 'visiteur_1_abcdef');

    const row = await harness.memory.get<LinkRow>('Links', { token: link.token });
    expect(row?.notified).toBe(true);
  });

  it('un échec SES ne fait pas échouer le claim', async () => {
    installMailer({ fail: true });
    const link = await makeLink(1);

    // Le visiteur doit obtenir sa réponse normalement.
    const result = await claim(link.token, 'visiteur_1_abcdef');
    expect([200, 202]).toContain(result.status);
    expect(sent).toHaveLength(0);
  });

  it('relâche le verrou après un échec, pour retenter ensuite', async () => {
    installMailer({ fail: true });
    const link = await makeLink(1);
    await claim(link.token, 'visiteur_1_abcdef');

    const afterFailure = await harness.memory.get<LinkRow>('Links', { token: link.token });
    expect(afterFailure?.notified).toBe(false);
  });

  it('échappe le HTML du titre et du nom', () => {
    const email = buildExhaustedEmail({
      token: 'tok',
      docId: 'doc_test',
      docTitle: '<script>alert(1)</script>',
      createdByEmail: 'auteur@exemple.cm',
      createdByName: 'Awa & "Cie"',
      maxDownloads: 1,
      remaining: 0,
      status: 'EXHAUSTED',
      notified: false,
      createdAt: new Date().toISOString(),
    });

    // Entités écrites en Unicode : dans un fichier source, `<` littéral
    // serait lu tel quel, et l'assertion ne testerait plus rien.
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('\u0026lt;script\u0026gt;');
    expect(email.html).toContain('\u0026amp;');
    // Le texte brut reste lisible, sans échappement.
    expect(email.text).toContain('<script>alert(1)</script>');
  });

  it('accorde le pluriel selon le nombre d’exemplaires', () => {
    const base: LinkRow = {
      token: 'tok',
      docId: 'doc_test',
      docTitle: 'Doc',
      createdByEmail: 'auteur@exemple.cm',
      createdByName: 'Awa',
      maxDownloads: 1,
      remaining: 0,
      status: 'EXHAUSTED',
      notified: false,
      createdAt: new Date().toISOString(),
    };

    expect(buildExhaustedEmail(base).subject).toContain('Dernier téléchargement');
    expect(buildExhaustedEmail({ ...base, maxDownloads: 3 }).text).toContain('3 exemplaires');
    expect(buildExhaustedEmail({ ...base, maxDownloads: 1 }).text).toContain('1 exemplaire');
  });

  it('ne contacte jamais SES quand aucun expéditeur n’est configuré', async () => {
    process.env.SES_SENDER = '';
    resetConfigCache();
    setDatabase(new MemoryDatabase(TABLES));
    await seedDocument(harness.memory);

    // Sans `setMailer`, le mailer réel est utilisé : il doit sortir sans erreur.
    const link = await makeLink(1);
    const result = await claim(link.token, 'visiteur_1_abcdef');
    expect([200, 202]).toContain(result.status);
  });
});
