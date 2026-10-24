/**
 * Notification e-mail du créateur quand le dernier exemplaire est distribué.
 *
 * Déclenchée par DynamoDB Streams sur la table Links : le chemin critique du
 * claim n'attend jamais SES (idempotence via `notified`, posé de façon
 * conditionnelle avant l'envoi).
 */
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from '../lib/config';
import { updateItem } from '../lib/db';
import type { LinkRow } from '../lib/types';

let ses: SESv2Client | null = null;

function sesClient(): SESv2Client {
  if (!ses) ses = new SESv2Client({ region: config().region });
  return ses;
}

interface StreamImage {
  [key: string]: { S?: string; N?: string; BOOL?: boolean };
}

function readImage(image: StreamImage | undefined): LinkRow | null {
  if (!image) return null;
  try {
    return unmarshall(image as never) as LinkRow;
  } catch {
    return null;
  }
}

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  const cfg = config();
  for (const record of event.Records) {
    if (record.eventName !== 'MODIFY' && record.eventName !== 'INSERT') continue;
    const next = readImage(record.dynamodb?.NewImage as StreamImage | undefined);
    if (!next) continue;
    if (next.status !== 'EXHAUSTED' || next.notified) continue;

    // Réservation atomique : un seul envoi, même si le Stream rejoue.
    try {
      await updateItem(
        cfg.linksTable,
        { token: next.token },
        {
          update: 'SET notified = :true, notifiedAt = :now',
          condition: 'notified = :false',
          values: { ':true': true, ':false': false, ':now': new Date().toISOString() },
        },
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') continue;
      throw error;
    }

    const subject = `Dernier exemplaire distribué — ${next.docTitle}`;
    const body = [
      `Bonjour ${next.createdByName},`,
      '',
      `Le lien de téléchargement du document « ${next.docTitle} » a distribué son dernier exemplaire.`,
      '',
      `Téléchargements autorisés : ${next.maxDownloads}`,
      `Téléchargements restants : 0`,
      '',
      'Les visiteurs suivants reçoivent désormais un message explicite : le lien est épuisé.',
      '',
      '— Éditeur de documents partagé',
    ].join('\n');

    try {
      await sesClient().send(
        new SendEmailCommand({
          FromEmailAddress: cfg.sesSender,
          Destination: { ToAddresses: [next.createdByEmail] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: { Text: { Data: body, Charset: 'UTF-8' } },
            },
          },
        }),
      );
      console.log('Notification envoyée', { token: next.token, to: next.createdByEmail });
    } catch (error) {
      // On libère la réservation pour permettre un nouveau passage du Stream.
      await updateItem(
        cfg.linksTable,
        { token: next.token },
        { update: 'SET notified = :false', values: { ':false': false } },
      ).catch(() => undefined);
      console.error('Échec de notification SES', error);
      throw error;
    }
  }
}
