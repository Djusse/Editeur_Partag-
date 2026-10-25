/**
 * Versions et restauration.
 *
 * Règle du plan v7 (correction 4.2-3) : une version est créée
 * **automatiquement** (toutes les 50 entrées de journal ou toutes les 2 minutes
 * d'activité), et **un snapshot du texte courant est pris avant chaque
 * restauration**. Sans ce second point, la phrase « le texte actuel reste dans
 * l'historique » serait fausse.
 *
 * L'interface n'expose donc **aucun bouton de création manuelle** de version.
 */
import * as Y from 'yjs';
import { config } from './config';
import { db } from './db';
import { invalidInput, notFound } from './errors';
import { getObject, putObject, snapshotKey } from './s3';
import { manager } from '../realtime/manager';
import { hashOf } from '../realtime/hub';
import { randomToken } from './ids';
import type { VersionRow } from './types';

export interface VersionSummary {
  n: number;
  createdAt: string;
  authorName: string;
  chars: number;
}

export async function listVersions(docId: string): Promise<VersionSummary[]> {
  const result = await db().query<VersionRow>(config().versionsTable, {
    keyCondition: 'docId = :docId',
    values: { ':docId': docId },
    scanForward: false,
    limit: 100,
  });
  return result.items.map((row) => ({
    n: row.n,
    createdAt: row.createdAt,
    authorName: row.authorName,
    chars: row.chars,
  }));
}

/** Enregistre une version (snapshot S3 + ligne `Versions`). Idempotent. */
export async function saveVersion(input: {
  docId: string;
  seq: number;
  state: Uint8Array;
  chars: number;
  authorEmail: string;
  authorName: string;
}): Promise<void> {
  const key = snapshotKey(input.docId, input.seq);
  await putObject(key, input.state, 'application/octet-stream');
  await db()
    .put(
      config().versionsTable,
      {
        docId: input.docId,
        n: input.seq,
        s3Key: key,
        authorEmail: input.authorEmail,
        authorName: input.authorName,
        chars: input.chars,
        createdAt: new Date().toISOString(),
      },
      { condition: 'attribute_not_exists(n)' },
    )
    .catch((error: unknown) => {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    });
}

/**
 * Restaure une version.
 *
 * 1. Snapshot du texte **courant** (pour qu'il reste dans l'historique).
 * 2. Application d'un **nouvel update** qui remplace le texte par celui de la
 *    version choisie : compatible CRDT, historique conservé, **gratuit** en
 *    crédit (update système).
 */
export async function restoreVersion(
  docId: string,
  n: number,
  authorEmail: string,
  authorName: string,
): Promise<number> {
  if (!Number.isInteger(n) || n <= 0) throw invalidInput('n', 'Numéro de version invalide.');

  const version = await db().get<VersionRow>(config().versionsTable, { docId, n });
  if (!version) throw notFound('Version inconnue.');

  const state = await manager.load(docId);

  // 1. Sauvegarde de l'état courant avant écrasement.
  const currentSnapshot = Y.encodeStateAsUpdate(state.ydoc);
  await saveVersion({
    docId,
    seq: state.seq,
    state: currentSnapshot,
    chars: state.ydoc.getText('content').length,
    authorEmail: 'system',
    authorName: 'Sauvegarde automatique',
  });

  // 2. Texte cible.
  const archived = await getObject(version.s3Key);
  const target = new Y.Doc();
  Y.applyUpdate(target, archived);
  const targetText = target.getText('content').toString();
  target.destroy();

  // 3. Différence calculée sur l'état **courant réel** : calculer sur un
  // document vide produirait des insertions sans suppression, donc une
  // duplication chez les autres clients au lieu d'un remplacement.
  const update = buildReplacementUpdate(state.ydoc, targetText);
  if (update.length === 0) return state.seq;

  const systemClient = {
    id: `system_restore_${randomToken(6)}`,
    socket: { readyState: 1, send: () => undefined } as never,
    email: authorEmail,
    name: authorName,
    color: '#2563EB',
    docId,
    seq: state.seq,
    cursor: null,
    // Restauration gratuite : elle doit aboutir même si l'auteur est bloqué
    // (crédit épuisé → 4 refus → écriture suspendue).
    system: true,
  };

  state.enqueue({
    client: systemClient,
    opId: `restore_${randomToken(10)}`,
    payload: update,
    // Restauration gratuite : aucun caractère facturé.
    chars: 0,
    inserted: 0,
    deleted: 0,
    hash: hashOf(update),
  });

  await state.flush();
  return state.seq;
}

/** Produit un update qui remplace le texte courant par `targetText`. */
export function buildReplacementUpdate(ydoc: Y.Doc, targetText: string): Uint8Array {
  const text = ydoc.getText('content');
  const captured: Uint8Array[] = [];
  const origin = Symbol('restore');
  const listener = (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin === origin) captured.push(update);
  };

  ydoc.on('update', listener);
  try {
    ydoc.transact(() => {
      const existing = text.toString();
      let start = 0;
      const maxStart = Math.min(existing.length, targetText.length);
      while (start < maxStart && existing[start] === targetText[start]) start++;

      let endExisting = existing.length;
      let endTarget = targetText.length;
      while (
        endExisting > start &&
        endTarget > start &&
        existing[endExisting - 1] === targetText[endTarget - 1]
      ) {
        endExisting--;
        endTarget--;
      }

      if (endExisting > start) text.delete(start, endExisting - start);
      if (endTarget > start) text.insert(start, targetText.slice(start, endTarget));
    }, origin);
  } finally {
    ydoc.off('update', listener);
  }

  return captured.length > 0 ? Y.mergeUpdates(captured) : new Uint8Array();
}
