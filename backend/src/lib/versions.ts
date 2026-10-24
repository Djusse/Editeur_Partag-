/**
 * Versions consultables et restauration.
 *
 * Une version = un snapshot S3 (`snapshots/{docId}/{seq}`) + le `seq` associé.
 * La restauration est compatible CRDT : on **applique un nouvel update** qui
 * remplace le texte courant par celui de la version choisie, l'historique est
 * conservé et la restauration est gratuite côté crédit (update système).
 */
import * as Y from 'yjs';
import { config } from './config';
import { getItem, putItem, query } from './db';
import { badRequest, notFound } from './errors';
import { getObject, putObject, snapshotKey } from './s3';
import { commitUpdate, loadDocumentState } from './updates';
import { randomToken } from './ids';
import type { VersionRow } from './types';

export interface VersionSummary {
  n: number;
  chars: number;
  createdAt: string;
  authorName: string;
  label: string;
}

export async function listVersions(docId: string): Promise<VersionSummary[]> {
  const result = await query<VersionRow>({
    table: config().versionsTable,
    keyCondition: 'docId = :docId',
    values: { ':docId': docId },
    scanForward: false,
    limit: 100,
  });
  return result.items.map((row, index) => ({
    n: row.n,
    chars: row.chars,
    createdAt: row.createdAt,
    authorName: row.authorName,
    label: index === 0 ? 'Version la plus récente' : `Version ${row.n}`,
  }));
}

/**
 * Crée une version nommée (snapshot explicite) à partir du journal courant.
 * Appelée par le handler `POST /documents/{id}/versions`.
 */
export async function createVersion(input: {
  docId: string;
  seq: number;
  state: Uint8Array;
  authorEmail: string;
  authorName: string;
  chars: number;
}): Promise<VersionRow> {
  const key = snapshotKey(input.docId, input.seq);
  await putObject(key, input.state, 'application/octet-stream');
  const row: VersionRow = {
    docId: input.docId,
    n: input.seq,
    s3Key: key,
    authorEmail: input.authorEmail,
    authorName: input.authorName,
    chars: input.chars,
    createdAt: new Date().toISOString(),
  };
  await putItem(config().versionsTable, row as unknown as Record<string, unknown>, {
    condition: 'attribute_not_exists(n)',
  }).catch((error: unknown) => {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
  });
  return row;
}

/** Texte d'une version : snapshot demandé + updates jusqu'à `n`. */
export async function versionText(docId: string, n: number): Promise<string> {
  const row = await getItem<VersionRow>(config().versionsTable, { docId, n });
  if (!row) throw notFound('VERSION_NOT_FOUND', 'Version inconnue');
  const snapshot = await getObject(row.s3Key);
  const updates = await query<{ seq: number; payload: Uint8Array }>({
    table: config().updatesTable,
    keyCondition: 'docId = :docId AND seq > :n',
    values: { ':docId': docId, ':n': n },
    scanForward: true,
  });
  // Le snapshot `n` contient déjà tout l'état ≤ n : rien à rejouer.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  return doc.getText('content').toString();
}

/**
 * Restauration : produit un update Yjs qui remplace le texte courant par celui
 * de la version choisie. Appliqué comme un update normal (mais gratuit).
 *
 * Point crucial : l'update est calculé sur un `Y.Doc` qui contient **l'état
 * courant réel**. Calculer la différence sur un document vide produirait des
 * insertions sans suppression, qui s'ajouteraient au texte existant chez les
 * autres clients au lieu de le remplacer.
 */
export async function buildRestoreUpdate(docId: string, n: number): Promise<Uint8Array> {
  const row = await getItem<VersionRow>(config().versionsTable, { docId, n });
  if (!row) throw notFound('VERSION_NOT_FOUND', 'Version inconnue');
  const snapshot = await getObject(row.s3Key);

  const target = new Y.Doc();
  Y.applyUpdate(target, snapshot);
  const targetText = target.getText('content').toString();

  const current = new Y.Doc();
  const state = await loadDocumentState(docId);
  if (state.snapshot) Y.applyUpdate(current, state.snapshot);
  for (const update of state.updates) Y.applyUpdate(current, update.payload);

  return buildReplacementUpdate(current, targetText);
}

/** Produit un update unique qui remplace le contenu par `targetText`. */
function buildReplacementUpdate(current: Y.Doc, targetText: string): Uint8Array {
  const text = current.getText('content');
  const captured: Uint8Array[] = [];
  const origin = Symbol('restore');
  const listener = (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin === origin) captured.push(update);
  };
  current.on('update', listener);
  try {
    current.transact(() => {
      // Différences de préfixe/suffixe : on ne touche qu'à la partie qui change,
      // ce qui préserve les identifiants CRDT du texte commun.
      const existing = text.toString();
      let start = 0;
      const maxStart = Math.min(existing.length, targetText.length);
      while (start < maxStart && existing[start] === targetText[start]) start++;

      let endExisting = existing.length;
      let endTarget = targetText.length;
      while (endExisting > start && endTarget > start && existing[endExisting - 1] === targetText[endTarget - 1]) {
        endExisting--;
        endTarget--;
      }

      if (endExisting > start) text.delete(start, endExisting - start);
      if (endTarget > start) text.insert(start, targetText.slice(start, endTarget));
    }, origin);
  } finally {
    current.off('update', listener);
  }
  return Y.mergeUpdates(captured);
}

/** Applique la restauration en tant qu'update système (crédit non débité). */
export async function restoreVersion(input: {
  docId: string;
  n: number;
  authorEmail: string;
  authorName: string;
}): Promise<{ seq: number }> {
  const update = await buildRestoreUpdate(input.docId, input.n);
  const result = await commitUpdate({
    docId: input.docId,
    authorEmail: input.authorEmail,
    authorName: input.authorName,
    opId: `restore_${randomToken(8)}`,
    payload: update,
    chargeCredit: false,
  });
  return { seq: result.seq };
}

export function validateVersionNumber(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) throw badRequest('INVALID_VERSION', 'Numéro de version invalide');
  return n;
}
