/**
 * Hub temps réel — **écrivain unique par document**.
 *
 * C'est le cœur du choix EC2 : un seul processus détient chaque document en
 * mémoire. Trois propriétés en découlent :
 *
 *  1. **séquence sans contention** : un seul écrivain fait avancer `seq`, donc
 *     aucun conflit n'est possible. La condition `seq = :s` reste une garde
 *     contre un second processus, pas une source de retry ;
 *  2. **diffusion groupée** : un tick de 250 ms fusionne les updates de tous les
 *     rédacteurs en **un seul message**. Sans cela, le fan-out serait
 *     quadratique (300 rédacteurs × 1 update/s × 300 destinataires) ;
 *  3. **acquittement après durabilité** : un update n'est acquitté qu'une fois
 *     écrit dans DynamoDB — c'est ce qui garantit C2 même après un plantage,
 *     puisque les clients renvoient alors les updates non acquittés.
 */
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { config } from '../lib/config';
import { db } from '../lib/db';
import { WsErrorCodes } from '../lib/errors';
import { sha256Hex, sleep, utcDay } from '../lib/ids';
import { blockedUntilFor, recordCreditRefusal } from '../lib/credits';
import { putObject, snapshotKey } from '../lib/s3';
import type { OpIdRow } from '../lib/types';

export interface Client {
  id: string;
  socket: WebSocket;
  email: string;
  name: string;
  color: string;
  docId: string;
  /** Dernier `seq` connu de ce client. */
  seq: number;
  cursor: number | null;
  awareness?: string;
  /**
   * Update **système** (restauration de version, par exemple).
   *
   * Il n'est pas facturé et doit rester acceptable même quand l'écriture de
   * l'auteur est bloquée : sans ce marqueur, la nouvelle garde de blocage
   * ajoutée dans `commitBatch` aurait rendu la restauration impossible pour un
   * utilisateur ayant épuisé son crédit — alors que la spécification la prévoit
   * explicitement gratuite.
   */
  system?: boolean;
}

export interface IncomingUpdate {
  client: Client;
  opId: string;
  payload: Uint8Array;
  chars: number;
  inserted: number;
  deleted: number;
  hash: string;
}

export function hashOf(payload: Uint8Array): string {
  return sha256Hex(payload);
}

/** État d'un document, entièrement en mémoire. */
export class DocumentState {
  readonly docId: string;
  readonly ydoc: Y.Doc;
  readonly clients = new Set<Client>();
  seq: number;
  latestSnapshotSeq: number;
  textLength: number;
  lastActivity: number;

  private queue: IncomingUpdate[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private committing = false;
  private lastSnapshotAt = Date.now();
  private entriesSinceSnapshot = 0;

  constructor(docId: string, seq: number, state: Uint8Array | undefined, latestSnapshotSeq: number, textLength: number) {
    this.docId = docId;
    this.ydoc = new Y.Doc();
    if (state) Y.applyUpdate(this.ydoc, state);
    this.seq = seq;
    this.latestSnapshotSeq = latestSnapshotSeq;
    this.textLength = textLength;
    this.lastActivity = Date.now();
  }

  enqueue(update: IncomingUpdate): void {
    this.queue.push(update);
    this.lastActivity = Date.now();
    this.ensureTimer();
  }

  /** Remet un lot non écrit en tête de file (crédit refusé, conflit, etc.). */
  replay(updates: IncomingUpdate[]): void {
    this.queue.unshift(...updates);
    this.ensureTimer();
  }

  pendingCount(): number {
    return this.queue.length;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, config().tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.committing || this.queue.length === 0) {
      if (this.queue.length === 0 && this.clients.size === 0) this.stop();
      return;
    }

    this.committing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await commitBatch(this, batch);
    } catch (error) {
      console.error('Échec du tick d\'écriture', { docId: this.docId, error });
      // Sans ce message, le client affichait « Connecté » et « N modifications
      // en attente » indéfiniment : le hub réessayait toutes les 250 ms sans
      // jamais rien dire. On prévient l'utilisateur, et on garde le lot en file :
      // la cause peut être transitoire (throttling, coupure réseau).
      const message = error instanceof Error ? error.message : 'Erreur inconnue';
      for (const update of batch) {
        send(update.client, {
          type: 'error',
          code: 'WRITE_FAILED',
          opId: update.opId,
          message: `Enregistrement impossible : ${message}`,
        });
      }
      this.replay(batch);
    } finally {
      this.committing = false;
    }
  }

  /** Force l'écriture immédiate (tests, arrêt propre). */
  async flush(): Promise<void> {
    while (this.committing) await sleep(20);
    if (this.queue.length === 0) return;
    this.committing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await commitBatch(this, batch);
    } finally {
      this.committing = false;
    }
  }

  markSnapshot(seq: number): void {
    this.latestSnapshotSeq = seq;
    this.lastSnapshotAt = Date.now();
    this.entriesSinceSnapshot = 0;
  }

  noteEntry(): void {
    this.entriesSinceSnapshot++;
  }

  shouldSnapshot(): boolean {
    const cfg = config();
    if (this.entriesSinceSnapshot >= cfg.snapshotEveryEntries) return true;
    return this.entriesSinceSnapshot > 0 && Date.now() - this.lastSnapshotAt >= cfg.snapshotEveryMs;
  }
}

/** Envoie un message JSON à un client si la connexion est ouverte. */
export function send(client: Client, message: unknown): void {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(message));
  }
}

async function currentCreditRemaining(email: string): Promise<number> {
  const cfg = config();
  const row = await db().get<{ used: number; limit: number }>(cfg.creditsTable, { id: `${email}#${utcDay()}` });
  const limit = row?.limit ?? cfg.creditPerDay;
  return Math.max(0, limit - (row?.used ?? 0));
}

/**
 * Écrit un lot d'updates dans **une seule** transaction atomique.
 *
 * Éléments (tous distincts, condition d'atomicité) :
 *  1. `Documents`   : `SET seq = :next`, condition `seq = :current`
 *  2. `Updates`     : Put du journal (updates fusionnés), condition `attribute_not_exists`
 *  3. `Credits`     : un élément **par expéditeur**, `ADD used :chars`
 *  4. `OpIds[OP#]`  : un marqueur par update, condition `attribute_not_exists`
 *  5. `OpIds[HASH#]`: un marqueur par contenu, condition `attribute_not_exists`
 *
 * Tout réussit ou rien n'est appliqué : ni trou de `seq`, ni crédit débité pour
 * un update non persisté, ni marqueur sans update.
 */
export interface BatchRejection {
  email: string;
  /** `BLOCKED` prime sur `CREDIT_EXHAUSTED` : c'est lui qui lève la session d'écriture. */
  code: 'CREDIT_EXHAUSTED' | 'BLOCKED';
  blockedUntil?: string;
  creditRemaining: number;
}

export async function commitBatch(
  state: DocumentState,
  batch: IncomingUpdate[],
): Promise<BatchRejection[]> {
  const cfg = config();
  const day = utcDay();
  const ttl = Math.floor(Date.now() / 1000) + 48 * 3600;

  // Doublons dans un même lot : ils casseraient la transaction (même clé).
  const seenOp = new Set<string>();
  const seenHash = new Set<string>();
  const unique: IncomingUpdate[] = [];
  for (const update of batch) {
    const opKey = `OP#${update.client.email}#${update.opId}`;
    if (seenOp.has(opKey) || seenHash.has(update.hash)) continue;
    seenOp.add(opKey);
    seenHash.add(update.hash);
    unique.push(update);
  }
  if (unique.length === 0) return [];

  const rejections: BatchRejection[] = [];

  // --- Garde de blocage ---------------------------------------------------
  // `assertNotBlocked` est vérifié à l'entrée du WebSocket, mais un lot peut
  // franchir la limite de refus **pendant** son traitement. Sans ce second
  // contrôle, l'update suivant était acquitté et facturé alors que l'écriture
  // était déjà suspendue : côté interface, plus rien ne signalait le blocage.
  // Les updates système (restauration de version) ne sont jamais bloqués : la
  // restauration est gratuite et reste possible une fois le crédit épuisé.
  const regular = unique.filter((update) => !update.client.system);
  const authors = new Set(regular.map((update) => update.client.email));
  const blockedUntilByAuthor = new Map<string, string>();
  await Promise.all(
    [...authors].map(async (email) => {
      const until = await blockedUntilFor(email);
      if (until) blockedUntilByAuthor.set(email, until);
    }),
  );

  let candidates = unique;
  if (blockedUntilByAuthor.size > 0) {
    for (const [email, until] of blockedUntilByAuthor) {
      const own = unique.filter((update) => update.client.email === email && !update.client.system);
      if (own.length === 0) continue;
      const remaining = await currentCreditRemaining(email);
      rejections.push({
        email,
        code: WsErrorCodes.blocked,
        blockedUntil: until,
        creditRemaining: remaining,
      });
      for (const update of own) {
        send(update.client, {
          type: 'error',
          code: WsErrorCodes.blocked,
          opId: update.opId,
          creditRemaining: remaining,
          blockedUntil: until,
          message: 'Écriture bloquée après trop de refus de crédit.',
        });
      }
    }
    // Un update système survit au blocage de son auteur : il est gratuit.
    candidates = unique.filter(
      (update) => update.client.system || !blockedUntilByAuthor.has(update.client.email),
    );
    if (candidates.length === 0) return rejections;
  }

  const byAuthor = new Map<string, IncomingUpdate[]>();
  for (const update of candidates) {
    const list = byAuthor.get(update.client.email) ?? [];
    list.push(update);
    byAuthor.set(update.client.email, list);
  }

  const nextSeq = state.seq + 1;
  const merged = Y.mergeUpdates(candidates.map((update) => update.payload));
  const insertedTotal = candidates.reduce((sum, update) => sum + update.inserted, 0);
  const deletedTotal = candidates.reduce((sum, update) => sum + update.deleted, 0);

  const entries: Parameters<ReturnType<typeof db>['transact']>[0] = [
    {
      Update: {
        table: cfg.documentsTable,
        key: { docId: state.docId },
        update: 'SET seq = :next, updatedAt = :now, textLength = :len',
        condition: 'seq = :current',
        values: {
          ':next': nextSeq,
          ':current': state.seq,
          ':now': new Date().toISOString(),
          ':len': Math.max(0, state.textLength + insertedTotal - deletedTotal),
        },
      },
    },
    {
      Put: {
        table: cfg.updatesTable,
        item: {
          docId: state.docId,
          seq: nextSeq,
          payload: merged,
          chars: insertedTotal + deletedTotal,
          ops: candidates.map((update) => ({
            opId: update.opId,
            authorEmail: update.client.email,
            chars: update.chars,
          })),
          createdAt: new Date().toISOString(),
        },
        condition: 'attribute_not_exists(seq)',
      },
    },
  ];

  // --- Contrôle du crédit, en lecture préalable ------------------------------
  //
  // DynamoDB **n'autorise pas l'arithmétique entre deux valeurs** dans une
  // `ConditionExpression` : `used + :chars <= :limit` lève
  //   ValidationException: Invalid ConditionExpression:
  //   Syntax error; token: "+", near: "used + :chars"
  // Ce défaut ne se voyait pas en test, car le double en mémoire évaluait
  // lui-même cette expression — il était plus permissif que le vrai service.
  //
  // La seule forme valide serait de comparer le compteur à une valeur
  // **littérale** calculée à l'avance, ce qui imposerait une écriture par
  // auteur. On préfère donc lire le compteur avant la transaction : le risque
  // de course est borné par l'écrivain unique du hub (un seul processus tient
  // le document), et la transaction reste la garde d'atomicité pour `seq`,
  // le journal et les marqueurs `opId`.
  const creditAuthorByIndex = new Map<number, string>();
  const overBudget = new Set<string>();

  await Promise.all(
    [...byAuthor].map(async ([email, updates]) => {
      const chars = updates.reduce((sum, update) => sum + update.chars, 0);
      const row = await db().get<{ used: number; limit: number }>(cfg.creditsTable, {
        id: `${email}#${day}`,
      });
      const used = row?.used ?? 0;
      const limit = row?.limit ?? cfg.creditPerDay;
      if (used + chars > limit) overBudget.add(email);
    }),
  );

  for (const [email, updates] of byAuthor) {
    // Auteur hors budget : il n'entre pas dans la transaction. Il sera traité
    // comme un refus (et fera l'objet d'un `recordCreditRefusal` plus bas).
    if (overBudget.has(email)) continue;

    const chars = updates.reduce((sum, update) => sum + update.chars, 0);
    creditAuthorByIndex.set(entries.length, email);
    entries.push({
      Update: {
        table: cfg.creditsTable,
        key: { id: `${email}#${day}` },
        update: 'ADD used :chars SET email = :email, #day = :day, #limit = :limit, #ttl = :ttl',
        // Condition uniquement sur l'existence : aucune arithmétique, c'est la
        // forme que DynamoDB accepte réellement.
        condition: 'attribute_not_exists(used) OR used >= :zero',
        names: { '#day': 'day', '#limit': 'limit', '#ttl': 'ttl' },
        values: {
          ':chars': chars,
          ':email': email,
          ':day': day,
          ':limit': cfg.creditPerDay,
          ':ttl': ttl,
          ':zero': 0,
        },
      },
    });
  }

  // Aucun auteur n'a de crédit suffisant : rien à persister. On annonce le
  // refus à chacun et on rend la main, sans transaction inutile.
  if (creditAuthorByIndex.size === 0) {
    for (const [email, updates] of byAuthor) {
      const own = updates.length;
      if (own === 0) continue;
      const refusal = await recordCreditRefusal(email, updates[0].opId);
      const remaining = await currentCreditRemaining(email);
      const code = refusal.blockedUntil ? WsErrorCodes.blocked : WsErrorCodes.creditExhausted;
      rejections.push({
        email,
        code,
        creditRemaining: remaining,
        ...(refusal.blockedUntil ? { blockedUntil: refusal.blockedUntil } : {}),
      });
      for (const update of updates) {
        send(update.client, {
          type: 'error',
          code,
          opId: update.opId,
          creditRemaining: remaining,
          ...(refusal.blockedUntil ? { blockedUntil: refusal.blockedUntil } : {}),
        });
      }
    }
    return rejections;
  }

  // Seuls les updates réellement persistés reçoivent un marqueur : en créer un
  // pour un update bloqué rendrait son `opId` acquitté plus tard, sans écriture.
  for (const update of candidates) {
    entries.push({
      Put: {
        table: cfg.opIdsTable,
        item: {
          id: `OP#${update.client.email}#${update.opId}`,
          hash: update.hash,
          seq: nextSeq,
          email: update.client.email,
          docId: state.docId,
          ttl,
        },
        condition: 'attribute_not_exists(id)',
      },
    });
    entries.push({
      Put: {
        table: cfg.opIdsTable,
        item: {
          id: `HASH#${state.docId}#${update.hash}`,
          hash: update.hash,
          seq: nextSeq,
          email: update.client.email,
          docId: state.docId,
          ttl,
        },
        condition: 'attribute_not_exists(id)',
      },
    });
  }

  const outcome = await db().transact(entries);

  if (outcome.ok) {
    applyAndBroadcast(state, merged, nextSeq, candidates);
    return rejections;
  }

  const reasons = outcome.reasons ?? [];

  // Quels expéditeurs ont réellement échoué sur le crédit ?
  const rejected = new Set<string>();
  for (const [index, email] of creditAuthorByIndex) {
    if (reasons[index]?.code === 'ConditionalCheckFailed') rejected.add(email);
  }

  const opConflict =
    rejected.size === 0 && reasons.some((reason) => reason.code === 'ConditionalCheckFailed');

  if (rejected.size > 0) {
    // Un seul refus ne doit pas bloquer les autres rédacteurs du même tick :
    // on retire les fautifs et on relance immédiatement les survivants.
    for (const email of rejected) {
      const own = candidates.filter((update) => update.client.email === email);
      if (own.length === 0) continue;
      const refusal = await recordCreditRefusal(email, own[0].opId);
      const remaining = await currentCreditRemaining(email);
      // `recordCreditRefusal` vient de franchir le seuil : l'écriture est
      // désormais bloquée, et c'est `BLOCKED` — pas `CREDIT_EXHAUSTED` — que
      // l'interface doit recevoir pour basculer en lecture seule.
      const code = refusal.blockedUntil ? WsErrorCodes.blocked : WsErrorCodes.creditExhausted;
      rejections.push({
        email,
        code,
        creditRemaining: remaining,
        ...(refusal.blockedUntil ? { blockedUntil: refusal.blockedUntil } : {}),
      });
      for (const update of own) {
        send(update.client, {
          type: 'error',
          code,
          opId: update.opId,
          creditRemaining: remaining,
          ...(refusal.blockedUntil ? { blockedUntil: refusal.blockedUntil } : {}),
        });
      }
    }

    const survivors = candidates.filter((update) => !rejected.has(update.client.email));
    if (survivors.length > 0) {
      rejections.push(...(await commitBatch(state, survivors)));
    }
    return rejections;
  }

  if (opConflict) {
    // Idempotence : un opId (ou un contenu) déjà accepté renvoie l'ack d'origine.
    const duplicates: IncomingUpdate[] = [];
    const fresh: IncomingUpdate[] = [];
    for (const update of candidates) {
      const marker =
        (await db().get<OpIdRow>(cfg.opIdsTable, { id: `OP#${update.client.email}#${update.opId}` })) ??
        (await db().get<OpIdRow>(cfg.opIdsTable, { id: `HASH#${state.docId}#${update.hash}` }));
      if (marker) duplicates.push(update);
      else fresh.push(update);
    }

    for (const update of duplicates) {
      send(update.client, {
        type: 'ack',
        opIds: [update.opId],
        seq: state.seq,
        creditRemaining: await currentCreditRemaining(update.client.email),
      });
    }
    if (fresh.length > 0) state.replay(fresh);
    return rejections;
  }

  // Conflit de séquence (autre processus, ou redémarrage) : on rejoue le lot.
  state.replay(candidates);
  return rejections;
}

/** Applique l'update fusionné en mémoire et diffuse **un seul** message. */
function applyAndBroadcast(
  state: DocumentState,
  merged: Uint8Array,
  seq: number,
  accepted: IncomingUpdate[],
): void {
  Y.applyUpdate(state.ydoc, merged);
  state.seq = seq;
  state.textLength = state.ydoc.getText('content').length;
  state.noteEntry();

  const payload = Buffer.from(merged).toString('base64');
  for (const client of state.clients) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    client.seq = seq;
    client.socket.send(JSON.stringify({ type: 'update', seq, documentId: state.docId, payload }));
  }

  // Un `ack` par expéditeur, avec la liste de ses `opIds` acquittés.
  const byClient = new Map<Client, string[]>();
  for (const update of accepted) {
    const list = byClient.get(update.client) ?? [];
    list.push(update.opId);
    byClient.set(update.client, list);
  }

  void (async () => {
    for (const [client, opIds] of byClient) {
      send(client, {
        type: 'ack',
        opIds,
        seq,
        creditRemaining: await currentCreditRemaining(client.email),
      });
    }
    await maybeSnapshot(state);
  })();
}

/**
 * Snapshot S3 **et** création d'une version consultable.
 *
 * Un snapshot sert deux buts :
 *  1. borner la taille du rattrapage (`latestSnapshotSeq`) et fournir la base
 *     du PDF ;
 *  2. être **listé dans la modale « Versions »**.
 *
 * Le point 2 avait été oublié : le fichier était bien écrit dans S3, mais aucune
 * ligne n'était ajoutée à la table `Versions`, donc l'interface affichait
 * toujours « Aucune version enregistrée ». Les deux écritures sont désormais
 * faites ensemble.
 *
 * Les snapshots sont pris automatiquement (50 entrées de journal ou 2 minutes
 * d'activité) : l'interface n'expose **aucun bouton** de création manuelle,
 * conformément à la spécification.
 */
async function maybeSnapshot(state: DocumentState): Promise<void> {
  if (!state.shouldSnapshot()) return;
  try {
    const seq = state.seq;
    const snapshot = Y.encodeStateAsUpdate(state.ydoc);
    await putObject(snapshotKey(state.docId, seq), snapshot, 'application/octet-stream');

    // Version consultable : c'est ce que lit `GET /documents/{id}/versions`.
    await db()
      .put(
        config().versionsTable,
        {
          docId: state.docId,
          n: seq,
          s3Key: snapshotKey(state.docId, seq),
          authorEmail: 'system',
          authorName: 'Enregistrement automatique',
          chars: state.textLength,
          createdAt: new Date().toISOString(),
        },
        { condition: 'attribute_not_exists(n)' },
      )
      .catch((error: unknown) => {
        // Une version déjà enregistrée pour ce `seq` n'est pas une erreur.
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      });

    await db().update(
      config().documentsTable,
      { docId: state.docId },
      {
        update: 'SET latestSnapshotSeq = :seq',
        condition: 'attribute_not_exists(latestSnapshotSeq) OR latestSnapshotSeq < :seq',
        values: { ':seq': seq },
      },
    );
    state.markSnapshot(seq);
  } catch (error) {
    console.warn('Snapshot ignoré', { docId: state.docId, error });
  }
}
