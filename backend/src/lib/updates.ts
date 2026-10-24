/**
 * Persistance des updates CRDT — cœur de C2 (aucune modification perdue) et C4
 * (crédit). **Une seule transaction DynamoDB** avance le `seq`, écrit l'update,
 * débite le crédit et pose les marqueurs d'idempotence : il ne peut donc pas y
 * avoir de trou dans les `seq`, ni de crédit débité pour un update non persisté.
 */
import * as Y from 'yjs';
import { config } from './config';
import { getItem, putItem, query, transactWrite } from './db';
import { getCredit, recordCreditRefusal, assertNotBlocked } from './credits';
import { ErrorCodes, ApiError, conflict, forbidden } from './errors';
import { jitter, sha256Hex, utcDay } from './ids';
import { getObject, putObject, snapshotKey } from './s3';
import { creditCost, InvalidUpdateError } from './yjs-update';
import { getDocument } from './documents';
import type { DocumentRow, OpIdRow, UpdateRow } from './types';

const MAX_CONFLICT_RETRIES = 6;
const OPID_TTL_SECONDS = 48 * 3600;

export interface CommitInput {
  docId: string;
  authorEmail: string;
  authorName: string;
  opId: string;
  payload: Uint8Array;
  /** Phase 2 : on peut désactiver la facturation (jamais en production). */
  chargeCredit?: boolean;
}

export interface CommitResult {
  seq: number;
  chars: number;
  inserted: number;
  deleted: number;
  duplicate: boolean;
}

export function opKey(email: string, opId: string): string {
  return `OP#${email}#${opId}`;
}

export function hashKey(docId: string, hash: string): string {
  return `HASH#${docId}#${hash}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Valide et comptabilise un update. Les contrôles de taille et de structure
 * sont faits **avant** toute écriture : rien ne doit être payé pour un update
 * qui sera refusé.
 */
export function prepareUpdate(payload: Uint8Array): { chars: number; inserted: number; deleted: number } {
  if (payload.length > config().maxUpdateBytes) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Update trop volumineux (max ${config().maxUpdateBytes} octets)`);
  }
  try {
    const { cost, counts } = creditCost(payload);
    return { chars: cost, inserted: counts.inserted, deleted: counts.deleted };
  } catch (error) {
    if (error instanceof InvalidUpdateError) {
      throw new ApiError(400, ErrorCodes.invalidUpdate, error.message);
    }
    throw error;
  }
}

export async function commitUpdate(input: CommitInput): Promise<CommitResult> {
  const cfg = config();
  const charge = input.chargeCredit !== false;
  const payload = input.payload;
  const { chars, inserted, deleted } = prepareUpdate(payload);
  const hash = sha256Hex(payload);
  const day = utcDay();
  const ttl = Math.floor(Date.now() / 1000) + OPID_TTL_SECONDS;
  const now = new Date().toISOString();

  if (charge) {
    await assertNotBlocked(input.authorEmail);
  }

  let lastConflict: unknown = null;
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const doc = await getDocument(input.docId);
    const nextSeq = doc.seq + 1;

    const items = [
      {
        // 0 : compteur de séquence du document (contigu, jamais de trou)
        update: {
          table: cfg.documentsTable,
          key: { docId: input.docId },
          update: 'SET seq = :next, updatedAt = :now, textLength = if_not_exists(textLength, :zero) + :delta',
          condition: 'seq = :current',
          values: {
            ':next': nextSeq,
            ':current': doc.seq,
            ':now': now,
            ':zero': 0,
            ':delta': inserted - deleted,
          },
        },
      },
      {
        // 1 : l'update lui-même
        put: {
          table: cfg.updatesTable,
          item: {
            docId: input.docId,
            seq: nextSeq,
            payload,
            authorEmail: input.authorEmail,
            authorName: input.authorName,
            opId: input.opId,
            chars,
            createdAt: now,
          } as unknown as Record<string, unknown>,
          condition: 'attribute_not_exists(seq)',
        },
      },
      {
        // 2 : crédit du jour (commun à tous les appareils de l'utilisateur)
        update: {
          table: cfg.creditsTable,
          key: { id: `${input.authorEmail}#${day}` },
          update: 'ADD used :delta SET email = :email, #day = :day, #limit = :limit, #ttl = :ttl',
          // Sur un compteur absent, `attribute_not_exists(used)` seul rendrait la
          // condition vraie : la première écriture pourrait dépasser le plafond.
          // On vérifie donc aussi `:delta <= :limit` dans ce cas.
          condition: '(attribute_not_exists(used) AND :delta <= :limit) OR (used + :delta <= :limit)',
          names: { '#day': 'day', '#limit': 'limit', '#ttl': 'ttl' },
          values: {
            ':delta': charge ? chars : 0,
            ':email': input.authorEmail,
            ':day': day,
            ':limit': cfg.creditPerDay,
            ':ttl': ttl,
          },
        },
      },
      {
        // 3 : marqueur d'idempotence par opId
        put: {
          table: cfg.opIdsTable,
          item: { id: opKey(input.authorEmail, input.opId), hash, seq: nextSeq, email: input.authorEmail, docId: input.docId, ttl },
          condition: 'attribute_not_exists(id)',
        },
      },
      {
        // 4 : marqueur d'idempotence par contenu (même contenu, autre opId)
        put: {
          table: cfg.opIdsTable,
          item: { id: hashKey(input.docId, hash), hash, seq: nextSeq, email: input.authorEmail, docId: input.docId, ttl },
          condition: 'attribute_not_exists(id)',
        },
      },
    ];

    const outcome = await transactWrite(items);
    if (outcome.ok) {
      return { seq: nextSeq, chars, inserted, deleted, duplicate: false };
    }

    const reasons = outcome.reasons ?? [];
    // Ordre garanti par la transaction posée ci-dessus.
    const creditReason = reasons[2]?.code;
    const opReason = reasons[3]?.code;
    const hashReason = reasons[4]?.code;

    if (opReason === 'ConditionalCheckFailed') {
      const marker = await getItem<OpIdRow>(cfg.opIdsTable, { id: opKey(input.authorEmail, input.opId) });
      if (marker && marker.hash === hash) {
        // Retry du même update : on renvoie l'acquittement d'origine, sans débit.
        return { seq: marker.seq, chars, inserted, deleted, duplicate: true };
      }
      if (marker) throw conflict(ErrorCodes.duplicateOpConflict, 'opId déjà utilisé avec un contenu différent');
      // Marqueur absent malgré l'échec : on réessaie.
      lastConflict = outcome.reasons;
      continue;
    }

    if (hashReason === 'ConditionalCheckFailed') {
      const marker = await getItem<OpIdRow>(cfg.opIdsTable, { id: hashKey(input.docId, hash) });
      if (marker) {
        return { seq: marker.seq, chars, inserted, deleted, duplicate: true };
      }
      lastConflict = outcome.reasons;
      continue;
    }

    if (creditReason === 'ConditionalCheckFailed') {
      const refusal = await recordCreditRefusal(input.authorEmail, input.opId);
      const credit = await getCredit(input.authorEmail);
      throw new ApiError(403, ErrorCodes.creditExhausted, 'Crédit d\'écriture épuisé pour aujourd\'hui', {
        ...credit,
        refusals: refusal.refusals,
        ...(refusal.blockedUntil ? { blockedUntil: refusal.blockedUntil, blocked: true } : {}),
      });
    }

    // Conflit sur le compteur `seq` (ou sur l'unicité de l'update) : backoff + jitter.
    lastConflict = outcome.reasons;
    await sleep(Math.min(400, 20 * 2 ** attempt) + jitter(50));
  }

  throw conflict('WRITE_CONTENTION', 'Trop de conflits d\'écriture simultanés, réessayez', {
    attempt: MAX_CONFLICT_RETRIES,
    last: lastConflict,
  });
}

/**
 * Updates postérieurs à `sinceSeq`, dans l'ordre des `seq`, **paginés jusqu'au
 * bout**.
 *
 * La pagination est obligatoire : une page unique tronquerait le journal et
 * produirait un PDF incomplet (violation de C3) ou une reconstruction partielle
 * de l'état chez un nouveau client. `maxPages` borne le pire cas pour ne pas
 * dépasser le timeout de la Lambda.
 */
export async function listUpdatesSince(
  docId: string,
  sinceSeq: number,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<UpdateRow[]> {
  const pageSize = options.pageSize ?? 1000;
  const maxPages = options.maxPages ?? 50;
  const collected: UpdateRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;

  do {
    const result = await query<UpdateRow>({
      table: config().updatesTable,
      keyCondition: 'docId = :docId AND seq > :since',
      values: { ':docId': docId, ':since': sinceSeq },
      limit: pageSize,
      scanForward: true,
      exclusiveStartKey,
    });
    collected.push(...result.items);
    exclusiveStartKey = result.lastKey;
    pages++;
  } while (exclusiveStartKey && pages < maxPages);

  if (exclusiveStartKey) {
    console.warn('Journal tronqué : trop d\'updates à charger', { docId, sinceSeq, pages });
  }
  return collected.sort((a, b) => a.seq - b.seq);
}

/**
 * Concatène snapshot + updates en un état complet (`encodeStateAsUpdate`).
 *
 * L'import de Yjs doit être **statique** : un `require()` dynamique échappe au
 * bundler esbuild et échouerait en production (`MODULE_NOT_FOUND`), car seuls
 * les bundles sont déployés — pas `node_modules`.
 */
export function stateFromJournal(updates: Array<{ payload: Uint8Array }>, snapshot?: Uint8Array): Uint8Array {
  const doc = new Y.Doc();
  if (snapshot) Y.applyUpdate(doc, snapshot);
  for (const update of updates) Y.applyUpdate(doc, update.payload);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * État complet (snapshot S3 + updates suivants) pour un nouveau client.
 *
 * Si le snapshot annoncé est absent ou illisible, on **repart du journal
 * complet** plutôt que de servir un état incomplet : mieux vaut lire plus que
 * de rendre un document tronqué.
 */
export async function loadDocumentState(docId: string): Promise<{ seq: number; snapshot?: Uint8Array; updates: UpdateRow[] }> {
  const doc = await getDocument(docId);
  let snapshot: Uint8Array | undefined;
  let from = 0;
  if (doc.latestSnapshotSeq > 0) {
    try {
      snapshot = await getObject(snapshotKey(docId, doc.latestSnapshotSeq));
      from = doc.latestSnapshotSeq;
    } catch {
      snapshot = undefined;
      from = 0;
    }
  }
  const updates = await listUpdatesSince(docId, from);
  return { seq: doc.seq, snapshot, updates };
}

/**
 * Crée un snapshot quand le journal dépasse le seuil. Idempotent : la clé S3
 * et le `seq` figé rendent deux exécutions concurrentes inoffensives.
 */
export async function maybeSnapshot(docId: string, stateProvider: (updates: UpdateRow[]) => Uint8Array): Promise<number | null> {
  const cfg = config();
  const doc: DocumentRow = await getDocument(docId);
  const interval = cfg.snapshotInterval;
  if (doc.seq - doc.latestSnapshotSeq < interval) return null;

  const updates = await listUpdatesSince(docId, doc.latestSnapshotSeq);
  if (updates.length < interval) return null;
  const seq = updates[updates.length - 1].seq;
  const merged = stateProvider(updates);
  await putObject(snapshotKey(docId, seq), merged, 'application/octet-stream');
  await putItem(
    cfg.versionsTable,
    {
      docId,
      n: seq,
      s3Key: snapshotKey(docId, seq),
      authorEmail: 'system',
      authorName: 'Sauvegarde automatique',
      chars: 0,
      createdAt: new Date().toISOString(),
    },
    { condition: 'attribute_not_exists(n)' },
  ).catch(() => undefined);
  const { updateItem } = await import('./db');
  await updateItem(
    cfg.documentsTable,
    { docId },
    {
      update: 'SET latestSnapshotSeq = :seq',
      condition: 'attribute_not_exists(latestSnapshotSeq) OR latestSnapshotSeq < :seq',
      values: { ':seq': seq },
    },
  ).catch(() => undefined);
  return seq;
}

/**
 * Compaction opportuniste, appelée après une écriture acceptée.
 *
 * Sans elle, `latestSnapshotSeq` resterait à 0 et chaque chargement devrait
 * relire tout le journal : le temps de réponse du PDF et de l'éditeur
 * dériverait avec l'âge du document.
 *
 * Idempotente et sans risque de course : la clé S3 et le `seq` figé sont
 * déterministes, et l'avancement de `latestSnapshotSeq` est conditionnel.
 */
export async function compactIfNeeded(docId: string): Promise<number | null> {
  return maybeSnapshot(docId, (updates) => stateFromJournal(updates));
}

export { forbidden };
