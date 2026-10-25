/**
 * Notification du créateur d'un lien (SES, e-mail transactionnel).
 *
 * Un seul message dans toute l'application : prévenir l'auteur qu'un lien vient
 * de distribuer son **dernier** exemplaire. Rien d'autre n'est envoyé — ni
 * inscription, ni rappel, ni relance — ce qui correspond exactement à l'usage
 * déclaré à AWS pour la sortie du bac à sable SES.
 *
 * Deux exigences :
 *  - **idempotence** : le verrou `notified` est posé de façon **conditionnelle**
 *    avant l'envoi. Deux claims concurrents ne peuvent donc pas produire deux
 *    e-mails ; seul celui qui fait passer `notified` de `false` à `true` envoie.
 *  - **non-blocage** : un échec SES ne doit jamais faire échouer un
 *    téléchargement. L'erreur est journalisée, puis ignorée. Au pire, le verrou
 *    est relâché pour permettre une nouvelle tentative au claim suivant.
 *
 * Le mécanisme d'envoi est injectable (`setMailer`), comme le stockage objet et
 * la file SQS : les tests n'appellent jamais AWS.
 */
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { config } from './config';
import { db } from './db';
import type { LinkRow } from './types';

/** Résultat d'un envoi : utilisé par les tests et pour la journalisation. */
export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

let override: Mailer | null = null;

/** Réservé aux tests et au mode local : injecte un transport factice. */
export function setMailer(mailer: Mailer | null): void {
  override = mailer;
}

class SesMailer implements Mailer {
  private client: SESv2Client | null = null;

  async send(email: OutgoingEmail): Promise<void> {
    const sender = config().sesSender;
    if (!sender) {
      // Pas d'expéditeur configuré : on n'essaie même pas. Le mode local n'a
      // pas de SES, et un déploiement sans SES_SENDER ne doit pas échouer.
      console.warn('SES_SENDER absent : notification non envoyée');
      return;
    }
    if (!this.client) this.client = new SESv2Client({ region: config().region });
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: sender,
        Destination: { ToAddresses: [email.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: email.text, Charset: 'UTF-8' },
              Html: { Data: email.html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
  }
}

export function mailer(): Mailer {
  return override ?? new SesMailer();
}

/** Construit le message de fin de quota. Exporté pour être testé. */
export function buildExhaustedEmail(link: LinkRow): OutgoingEmail {
  const titre = link.docTitle || 'votre document';
  const pluriel = link.maxDownloads > 1 ? 'exemplaires' : 'exemplaire';
  const sujet = `Dernier téléchargement distribué — ${titre}`;

  const texte = [
    `Bonjour ${link.createdByName || ''},`.trim(),
    '',
    `Le dernier des ${link.maxDownloads} ${pluriel} du lien de téléchargement`,
    `que vous avez créé pour « ${titre} » vient d'être distribué.`,
    '',
    'Le lien est maintenant épuisé : plus aucun téléchargement ne sera possible.',
    '',
    'Vous pouvez créer un nouveau lien depuis la page « Liens de téléchargement »',
    'du document.',
    '',
    "Cet e-mail est envoyé une seule fois, au moment où le quota est atteint.",
    "Merci de ne pas y répondre.",
  ].join('\n');

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#F8FAFC;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0F172A">
  <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:8px">
    <tr><td style="padding:28px">
      <h1 style="margin:0 0 16px;font-size:18px;font-weight:600">Dernier téléchargement distribué</h1>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6">
        Bonjour ${escapeHtml(link.createdByName || '')},
      </p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6">
        Le dernier des <strong>${link.maxDownloads} ${pluriel}</strong> du lien de
        téléchargement que vous avez créé pour
        «&nbsp;<strong>${escapeHtml(titre)}</strong>&nbsp;» vient d&#8217;être distribué.
      </p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6">
        Le lien est maintenant <strong>épuisé</strong> : plus aucun téléchargement ne sera possible.
      </p>
      <p style="margin:0;font-size:14px;line-height:1.6">
        Vous pouvez créer un nouveau lien depuis la page
        «&nbsp;Liens de téléchargement&nbsp;» du document.
      </p>
      <hr style="border:none;border-top:1px solid #E2E8F0;margin:20px 0">
      <p style="margin:0;font-size:12px;color:#64748B;line-height:1.6">
        Cet e-mail est envoyé une seule fois, au moment où le quota est atteint.
        Merci de ne pas y répondre.
      </p>
    </td></tr>
  </table>
</body></html>`;

  return { to: link.createdByEmail, subject: sujet, text: texte, html };
}

/**
 * Échappement minimal : le titre et le nom sont saisis par l'utilisateur.
 *
 * Les entités sont écrites en séquences Unicode (`\u0026` pour `&`) : dans un
 * fichier source, une entité littérale serait lue comme du texte brut, et
 * l'échappement ne protégerait plus rien.
 */
function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    '\u0026': '\u0026amp;',
    '\u003c': '\u0026lt;',
    '\u003e': '\u0026gt;',
    '"': '\u0026quot;',
    "'": '\u0026#39;',
  };
  return value.replace(/[\u0026<>"']/g, (char) => entities[char] ?? char);
}

/**
 * Prévient l'auteur que le lien vient d'être épuisé.
 *
 * À appeler **après** la transition `ACTIVE → EXHAUSTED`. La méthode ne lève
 * jamais : un problème de messagerie ne doit pas empêcher un visiteur de
 * télécharger son exemplaire, déjà réservé.
 *
 * @returns `true` si cet appel a effectivement envoyé l'e-mail.
 */
export async function notifyLinkExhausted(link: LinkRow): Promise<boolean> {
  const cfg = config();

  // Verrou d'idempotence : seule la transition false → true envoie.
  // `attribute_not_exists(notified) OR notified = :false` couvre les liens créés
  // avant l'ajout du champ, absents de la table.
  try {
    await db().update(
      cfg.linksTable,
      { token: link.token },
      {
        update: 'SET notified = :true, notifiedAt = :now',
        condition: 'attribute_not_exists(notified) OR notified = :false',
        values: { ':true': true, ':false': false, ':now': new Date().toISOString() },
      },
    );
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'ConditionalCheckFailedException') {
      // Déjà notifié : c'est le cas normal d'un second appel. Pas une erreur.
      return false;
    }
    console.warn('Notification : verrou non posé, envoi abandonné', { token: link.token, error });
    return false;
  }

  try {
    await mailer().send(buildExhaustedEmail(link));
    return true;
  } catch (error) {
    console.warn('Notification : envoi SES en échec', { token: link.token, error });
    // On relâche le verrou : le prochain claim (ou un nouvel appel de la route
    // de vérification) pourra retenter. Mieux vaut un doublon rare qu'un
    // créateur jamais prévenu.
    await db()
      .update(cfg.linksTable, { token: link.token }, { update: 'SET notified = :false', values: { ':false': false } })
      .catch(() => undefined);
    return false;
  }
}
