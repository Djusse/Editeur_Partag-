/**
 * Lambda de génération PDF, invoquée en asynchrone (`InvocationType: Event`)
 * par le claim. Elle travaille toujours sur la `seq` figée du ticket (C3) et
 * alimente le cache par version, partagé par tous les visiteurs (C5).
 */
import { buildPdfForVersion } from '../lib/pdf';

interface Payload {
  docId: string;
  seq: number;
  cacheId: string;
}

export async function handler(event: Payload): Promise<void> {
  if (!event?.docId || !Number.isFinite(event.seq) || !event.cacheId) {
    throw new Error('Événement PDF invalide');
  }
  await buildPdfForVersion(event);
}
