/**
 * Gestionnaire des documents en mémoire.
 *
 * Responsabilités :
 *  - charger un document (snapshot + journal) et l'ouvrir au premier client ;
 *  - décharger un document inactif (libère la mémoire) ;
 *  - fournir l'état complet (`GET /documents/{id}/state`) ;
 *  - rattraper les updates manquants (`sinceSeq`) ;
 *  - diffuser la présence.
 *
 * Le verrou par document (`loading`) empêche deux connexions simultanées de
 * construire deux `Y.Doc` et donc deux écrivains concurrents.
 */
import * as Y from 'yjs';
import { config } from '../lib/config';
import { db } from '../lib/db';
import { notFound } from '../lib/errors';
import { colorFor } from '../lib/ids';
import { getObject, snapshotKey } from '../lib/s3';
import { DocumentState, send, type Client } from './hub';
import type { DocumentRow, UpdateRow } from '../lib/types';

interface LoadedDoc {
  state: DocumentState;
  loadedAt: number;
}

const MAX_UPDATES_PER_CATCH_UP = 2000;

export class DocumentManager {
  private readonly docs = new Map<string, LoadedDoc>();
  private readonly loading = new Map<string, Promise<LoadedDoc>>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const [, doc] of this.docs) {
      doc.state.stop();
      doc.state.ydoc.destroy();
    }
    this.docs.clear();
  }

  /** Document en mémoire, chargé si nécessaire (lecture seule). */
  get(docId: string): DocumentState | undefined {
    return this.docs.get(docId)?.state;
  }

  /** Charge le document en mémoire (idempotent, verrouillé pendant le chargement). */
  async load(docId: string): Promise<DocumentState> {
    const existing = this.docs.get(docId);
    if (existing) return existing.state;

    const inFlight = this.loading.get(docId);
    if (inFlight) return (await inFlight).state;

    const promise = this.build(docId);
    this.loading.set(docId, promise);
    try {
      const loaded = await promise;
      this.docs.set(docId, loaded);
      return loaded.state;
    } finally {
      this.loading.delete(docId);
    }
  }

  private async build(docId: string): Promise<LoadedDoc> {
    const cfg = config();
    const doc = await db().get<DocumentRow>(cfg.documentsTable, { docId });
    if (!doc) throw notFound('Document introuvable.');

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

    const state = new DocumentState(docId, doc.seq, snapshot, doc.latestSnapshotSeq, doc.textLength);
    // On rejoue le journal pour être sûr d'être à jour, même si `seq` annoncé
    // est supérieur à celui du snapshot (écriture après le dernier snapshot).
    const updates = await this.fetchUpdates(docId, from);
    for (const update of updates) {
      Y.applyUpdate(state.ydoc, update.payload);
    }
    if (updates.length > 0) {
      state.seq = Math.max(state.seq, updates[updates.length - 1].seq);
      state.textLength = state.ydoc.getText('content').length;
    }

    return { state, loadedAt: Date.now() };
  }

  private async fetchUpdates(docId: string, since: number, upTo?: number): Promise<UpdateRow[]> {
    const cfg = config();
    const collected: UpdateRow[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let pages = 0;

    do {
      const page = await db().query<UpdateRow>(cfg.updatesTable, {
        keyCondition: 'docId = :docId AND seq > :since',
        values: { ':docId': docId, ':since': since },
        limit: 500,
        scanForward: true,
        exclusiveStartKey,
      });

      for (const row of page.items) {
        if (upTo !== undefined && row.seq > upTo) {
          return collected;
        }
        collected.push(row);
        if (collected.length >= MAX_UPDATES_PER_CATCH_UP) return collected;
      }
      exclusiveStartKey = page.lastKey;
      pages++;
    } while (exclusiveStartKey && pages < 40);

    return collected;
  }

  /** État Yjs complet à un `seq` donné (Base64 dans la route). */
  async stateUpTo(docId: string, upTo?: number): Promise<{ seq: number; state: Uint8Array }> {
    const cfg = config();
    const doc = await db().get<DocumentRow>(cfg.documentsTable, { docId });
    if (!doc) throw notFound('Document introuvable.');
    const limit = upTo ?? doc.seq;

    const inMemory = this.docs.get(docId)?.state;
    if (inMemory && limit === inMemory.seq) {
      return { seq: inMemory.seq, state: Y.encodeStateAsUpdate(inMemory.ydoc) };
    }

    let snapshot: Uint8Array | undefined;
    let from = 0;
    if (doc.latestSnapshotSeq > 0 && doc.latestSnapshotSeq <= limit) {
      try {
        snapshot = await getObject(snapshotKey(docId, doc.latestSnapshotSeq));
        from = doc.latestSnapshotSeq;
      } catch {
        snapshot = undefined;
        from = 0;
      }
    }

    const updates = await this.fetchUpdates(docId, from, limit);
    const ydoc = new Y.Doc();
    if (snapshot) Y.applyUpdate(ydoc, snapshot);
    for (const update of updates) Y.applyUpdate(ydoc, update.payload);
    const state = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();

    return { seq: limit, state };
  }

  /** Updates postérieurs à `sinceSeq` (rattrapage après reconnexion). */
  async updatesSince(docId: string, sinceSeq: number): Promise<Array<{ seq: number; payload: Uint8Array }>> {
    const inMemory = this.docs.get(docId)?.state;
    let from = sinceSeq;

    if (inMemory) {
      // En mémoire : on ne sert que ce que le hub n'a pas encore diffusé.
      from = Math.min(sinceSeq, inMemory.seq);
      if (sinceSeq >= inMemory.seq) return [];
    }

    const rows = await this.fetchUpdates(docId, from);
    return rows.map((row) => ({ seq: row.seq, payload: row.payload }));
  }

  /** Dernier `seq` réellement écrit (source de T1). */
  async lastSeq(docId: string): Promise<number> {
    const inMemory = this.docs.get(docId)?.state;
    if (inMemory) return inMemory.seq;
    const doc = await db().get<{ seq: number }>(config().documentsTable, { docId });
    return doc?.seq ?? 0;
  }

  /** Attache un client et diffuse la nouvelle présence. */
  join(docId: string, state: DocumentState, client: Client): void {
    state.clients.add(client);
    this.broadcastPresence(docId, state);
  }

  /** Détache un client et diffuse la présence restante. */
  leave(docId: string, clientId: string): void {
    const state = this.docs.get(docId)?.state;
    if (!state) return;
    for (const client of state.clients) {
      if (client.id === clientId) state.clients.delete(client);
    }
    this.broadcastPresence(docId, state);
  }

  clients(docId: string): Client[] {
    return [...(this.docs.get(docId)?.state.clients ?? [])];
  }

  /** Liste de présence (une entrée par e-mail, soi-même inclus). */
  presence(docId: string): Array<{ email: string; name: string; color: string }> {
    const seen = new Map<string, { email: string; name: string; color: string }>();
    for (const client of this.clients(docId)) {
      if (!seen.has(client.email)) {
        seen.set(client.email, { email: client.email, name: client.name, color: client.color });
      }
    }
    return [...seen.values()];
  }

  broadcastPresence(docId: string, state?: DocumentState): void {
    const target = state ?? this.docs.get(docId)?.state;
    if (!target) return;
    const users = this.presence(docId);
    for (const client of target.clients) {
      send(client, { type: 'presence', users });
    }
  }

  /** Diffuse un update d'awareness (curseurs) à tous sauf l'expéditeur. */
  broadcastAwareness(docId: string, from: Client, payload: string): void {
    const state = this.docs.get(docId)?.state;
    if (!state) return;
    for (const client of state.clients) {
      if (client.id === from.id) continue;
      send(client, { type: 'awareness', documentId: docId, payload });
    }
  }

  /** Documents ouverts (supervision). */
  openDocuments(): Array<{ docId: string; connections: number; seq: number; title?: string }> {
    return [...this.docs.entries()]
      .filter(([, entry]) => entry.state.clients.size > 0)
      .map(([docId, entry]) => ({
        docId,
        connections: entry.state.clients.size,
        seq: entry.state.seq,
      }));
  }

  /** Décharge les documents sans client et inactifs. */
  private sweep(): void {
    const now = Date.now();
    for (const [docId, entry] of this.docs) {
      const clientCount = entry.state.clients.size;
      if (clientCount > 0) continue;
      if (now - entry.state.lastActivity < config().idleDocMs) continue;
      entry.state.stop();
      entry.state.ydoc.destroy();
      this.docs.delete(docId);
    }
  }

  /** Force le déchargement (tests). */
  evict(docId: string): void {
    const entry = this.docs.get(docId);
    if (!entry) return;
    entry.state.stop();
    entry.state.ydoc.destroy();
    this.docs.delete(docId);
  }

  /** Couleur de présence d'un rédacteur (identique au front). */
  colorFor(email: string): string {
    return colorFor(email);
  }
}

export const manager = new DocumentManager();
