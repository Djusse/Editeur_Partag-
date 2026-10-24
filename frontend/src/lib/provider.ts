/**
 * Provider Yjs sur WebSocket natif (`ws` côté serveur, `/ws` côté nginx).
 *
 * Règles exactes de la spécification d'interface (section 9.4) :
 *  - les frappes sont regroupées toutes les `BATCH_MS` (300 ms) en **un** update ;
 *  - chaque update reçoit un `opId` stable et entre dans la file `pendingOps`,
 *    **persistée** dans `localStorage` (clé `pendingOps:<docId>:<email>`) ;
 *  - aucun découpage : au-delà de 64 Ko binaires, on applique la procédure de
 *    rejet (message dédié), on ne découpe jamais ;
 *  - sans `ack` sous 10 s (ou sans réponse d'envoi), renvoi avec le **même**
 *    `opId`, délais 1/2/4/8 s puis 8 s, avec ±25 % de variation ;
 *  - à la reconnexion : rejouer `pendingOps` dans l'ordre, puis `join` avec le
 *    dernier `seq` connu ;
 *  - un `ack` retire **tous** les `opIds` qu'il contient et met à jour la jauge.
 *
 * Rejet (crédit, blocage, accès, taille) : cf. `handleRejection`, qui délègue
 * la reconstruction du document à la page (section 9.5).
 */
import * as Y from 'yjs';
import { savePendingOps, type PendingOp } from './api';
import { uuidv4, wsUrl } from './utils';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface Peer {
  email: string;
  name: string;
}

export type RejectionCode = 'CREDIT_EXHAUSTED' | 'BLOCKED' | 'FORBIDDEN' | 'PAYLOAD_TOO_LARGE';

/** Charge utile d'un refus : section 9.5 et 9.6 de la spécification. */
export interface RejectionPayload {
  code: RejectionCode;
  blockedUntil?: string;
  message?: string;
  /**
   * Crédit restant annoncé avec le refus.
   *
   * Sans lui, la jauge restait figée à sa dernière valeur connue (souvent
   * « 1 / 10 000 ») au lieu de tomber à zéro : l'utilisateur ne comprenait pas
   * pourquoi l'écriture s'arrêtait.
   */
  creditRemaining?: number;
}

export interface ProviderCallbacks {
  onState?: (state: ConnectionState) => void;
  onPresence?: (users: Peer[]) => void;
  onAck?: (payload: { seq: number; creditRemaining: number }) => void;
  onRejection?: (payload: RejectionPayload) => void;
  onQueueChange?: (size: number) => void;
  onRemoteUpdate?: () => void;
}

export interface ProviderOptions {
  documentId: string;
  email: string;
  token: string;
  batchMs?: number;
  getTicket: () => Promise<string>;
  callbacks?: ProviderCallbacks;
}

const MAX_UPDATE_BYTES = 64 * 1024;
const ACK_TIMEOUT_MS = 10_000;
const RETRY_DELAYS = [1000, 2000, 4000, 8000];

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

interface QueuedOp extends PendingOp {
  bytes: number;
  attempts: number;
  sentAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class CollaborativeProvider {
  readonly doc: Y.Doc;
  private readonly options: ProviderOptions;
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'offline';
  private queue: QueuedOp[] = [];
  private buffer: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private readOnly = false;
  /**
   * Code du dernier refus subi (`CREDIT_EXHAUSTED`, `BLOCKED`, `FORBIDDEN`).
   *
   * Il est mémorisé pour deux raisons : éviter de rejouer la procédure de
   * rejet à chaque reconnexion (le serveur renvoie `readOnly` dans chaque
   * `joined`, ce qui provoquait une boucle reconstruire → reconnecter →
   * reconstruire), et rester en lecture seule tant que la page n'est pas
   * rechargée (section 9.6 : « L'écriture n'est réactivée qu'après un
   * rechargement de la page »).
   */
  private rejectionCode: RejectionCode | null = null;
  private lastSeq = 0;
  /** `pendingOps` rejouées depuis `localStorage`, en attente du `join`. */
  private pendingFromStorage: PendingOp[] = [];
  private joined = false;

  constructor(doc: Y.Doc, options: ProviderOptions) {
    this.doc = doc;
    this.options = options;
    this.doc.on('update', this.handleLocalUpdate);
  }

  /** Charge la file persistée (à appeler avant `connect`). */
  loadPending(ops: PendingOp[]): void {
    this.pendingFromStorage = ops;
  }

  /** Ouvre la connexion. `sinceSeq` vient de `GET /documents/{id}/state`. */
  async connect(sinceSeq: number): Promise<void> {
    this.lastSeq = sinceSeq;
    // Rejoue localement les updates non acquittées : sans cela, l'utilisateur
    // ne reverrait pas ses frappes après un rechargement de page.
    for (const op of this.pendingFromStorage) {
      try {
        Y.applyUpdate(this.doc, fromBase64(op.update));
      } catch {
        /* update illisible : il sera abandonné à l'envoi */
      }
    }
    this.pendingFromStorage = [];

    await this.open();
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.options.callbacks?.onState?.(state);
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    this.setState(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    try {
      const ticket = await this.options.getTicket();
      const socket = new WebSocket(wsUrl(ticket, this.options.documentId));

      socket.onopen = () => {
        this.reconnectAttempts = 0;
        this.joined = false;
        this.setState('connected');
        socket.send(
          JSON.stringify({
            type: 'join',
            documentId: this.options.documentId,
            sinceSeq: this.lastSeq,
          }),
        );
      };

      socket.onmessage = (event) => this.handleMessage(event);
      socket.onerror = () => this.handleClose();
      socket.onclose = () => this.handleClose();

      this.socket = socket;
    } catch {
      this.setState('offline');
      this.scheduleReconnect();
    }
  }

  private handleClose(): void {
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      try {
        this.socket.close();
      } catch {
        /* déjà fermé */
      }
      this.socket = null;
    }
    this.joined = false;
    if (this.closed) return;
    this.setState('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const base = Math.min(15_000, 500 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, base + Math.random() * 400);
  }

  // --- Messages entrants ---------------------------------------------------
  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') return;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(message.type ?? '');

    if (type === 'joined') {
      const seq = Number(message.seq ?? 0);
      this.lastSeq = Math.max(this.lastSeq, seq);
      this.joined = true;

      // `readOnly` accompagne **chaque** `joined` (ouverture, puis chaque
      // `join {sinceSeq}`). Sans le garde `rejectionCode === null`, la
      // procédure de rejet se rejouait à chaque reconnexion : reconstruction
      // du document, nouvelle connexion, nouveau rejet… boucle infinie, avec
      // un toast empilé par tour.
      if (typeof message.readOnly === 'string' && this.rejectionCode === null) {
        this.handleRejection({
          code: message.readOnly as RejectionCode,
          blockedUntil: typeof message.blockedUntil === 'string' ? message.blockedUntil : undefined,
          creditRemaining: typeof message.creditRemaining === 'number' ? message.creditRemaining : undefined,
        });
        return;
      }

      // Une fois synchronisé, on renvoie la file dans l'ordre — sauf en
      // lecture seule, où il n'y a plus rien à envoyer.
      if (!this.readOnly) this.resendQueue();
      return;
    }

    if (type === 'update' && typeof message.payload === 'string') {
      const seq = Number(message.seq ?? 0);
      if (seq > this.lastSeq) {
        try {
          Y.applyUpdate(this.doc, fromBase64(message.payload), 'remote');
        } catch {
          /* update corrompu : ignoré, le rattrapage corrigera */
        }
        this.lastSeq = seq;
        this.options.callbacks?.onRemoteUpdate?.();
      }
      return;
    }

    if (type === 'ack') {
      const opIds = Array.isArray(message.opIds) ? (message.opIds as string[]) : [];
      this.acknowledge(opIds);
      this.options.callbacks?.onAck?.({
        seq: Number(message.seq ?? 0),
        creditRemaining: Number(message.creditRemaining ?? 0),
      });
      return;
    }

    if (type === 'presence' && Array.isArray(message.users)) {
      this.options.callbacks?.onPresence?.(message.users as Peer[]);
      return;
    }

    if (type === 'error') {
      const code = String(message.code ?? 'ERROR');
      if (code === 'CREDIT_EXHAUSTED' || code === 'BLOCKED' || code === 'FORBIDDEN' || code === 'PAYLOAD_TOO_LARGE') {
        // `creditRemaining` accompagne le refus : il met la jauge à zéro sans
        // appel réseau supplémentaire.
        this.handleRejection({
          code: code as RejectionCode,
          blockedUntil: typeof message.blockedUntil === 'string' ? message.blockedUntil : undefined,
          message: typeof message.message === 'string' ? message.message : undefined,
          creditRemaining: typeof message.creditRemaining === 'number' ? message.creditRemaining : undefined,
        });
        return;
      }
      const opId = typeof message.opId === 'string' ? message.opId : '';
      if (opId) this.acknowledge([opId]);
    }
  }

  /**
   * Procédure de rejet (section 9.5).
   *
   * Un update refusé est déjà affiché localement mais invisible pour les
   * autres : on cesse d'envoyer, on vide la file, et la page reconstruit le
   * document depuis le serveur (callback `onRejection`).
   */
  private handleRejection(payload: RejectionPayload): void {
    if (payload.code !== 'PAYLOAD_TOO_LARGE') {
      this.readOnly = true;
      this.rejectionCode = payload.code;
    }
    // Section 9.5, étape 1 : cesser d'envoyer et vider `pendingOps` (mémoire
    // **et** `localStorage`). Sans le second, la file refusée serait rejouée au
    // prochain chargement de la page.
    for (const op of this.queue) {
      if (op.timer) clearTimeout(op.timer);
    }
    this.queue = [];
    this.buffer = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.persist();
    this.options.callbacks?.onQueueChange?.(0);
    this.options.callbacks?.onRejection?.(payload);
  }

  // --- Envoi ---------------------------------------------------------------
  private handleLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === 'remote') return;
    if (this.readOnly) return;

    this.buffer.push(update);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueueBuffer();
    }, this.options.batchMs ?? 300);
  };

  private enqueueBuffer(): void {
    if (this.buffer.length === 0) return;
    const merged = Y.mergeUpdates(this.buffer);
    this.buffer = [];

    if (merged.length > MAX_UPDATE_BYTES) {
      // Aucun découpage : on rejette proprement avec le message consacré.
      this.options.callbacks?.onRejection?.({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Cette modification est trop volumineuse et n\'a pas été enregistrée.',
      });
      return;
    }

    this.queue.push({
      opId: `op_${uuidv4()}`,
      update: toBase64(merged),
      bytes: merged.length,
      attempts: 0,
      sentAt: null,
      timer: null,
    });
    this.persist();
    this.sendNext();
  }

  private sendNext(): void {
    if (this.readOnly) return;
    const op = this.queue.find((entry) => entry.sentAt === null);
    if (!op) return;

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.joined) {
      // Pas encore connecté : la reconnexion renverra la file.
      return;
    }

    op.attempts++;
    op.sentAt = Date.now();
    this.socket.send(
      JSON.stringify({
        type: 'update',
        opId: op.opId,
        documentId: this.options.documentId,
        payload: op.update,
      }),
    );

    // Sans `ack` sous 10 s : renvoi **avec le même opId** (déduplication serveur).
    op.timer = setTimeout(() => {
      op.sentAt = null;
      op.timer = null;
      if (op.attempts < RETRY_DELAYS.length + 3) this.sendNext();
    }, ACK_TIMEOUT_MS);
    void RETRY_DELAYS;
  }

  /** Renvoie toute la file dans l'ordre (reconnexion, `joined`). */
  private resendQueue(): void {
    for (const op of this.queue) {
      if (op.timer) clearTimeout(op.timer);
      op.timer = null;
      op.sentAt = null;
    }
    this.sendNext();
  }

  private acknowledge(opIds: string[]): void {
    if (opIds.length === 0) return;
    const accepted = new Set(opIds);
    this.queue = this.queue.filter((op) => {
      if (!accepted.has(op.opId)) return true;
      if (op.timer) clearTimeout(op.timer);
      return false;
    });
    this.persist();
    this.sendNext();
  }

  private persist(): void {
    savePendingOps(
      this.options.documentId,
      this.options.email,
      this.queue.map((op) => ({ opId: op.opId, update: op.update })),
    );
    this.options.callbacks?.onQueueChange?.(this.queue.length);
  }

  // --- Divers --------------------------------------------------------------
  sendAwareness(payload: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'awareness', documentId: this.options.documentId, payload }));
    }
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  queueSize(): number {
    return this.queue.length;
  }

  currentSeq(): number {
    return this.lastSeq;
  }

  destroy(): void {
    this.closed = true;
    this.doc.off('update', this.handleLocalUpdate);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const op of this.queue) if (op.timer) clearTimeout(op.timer);
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onclose = null;
      try {
        this.socket.close();
      } catch {
        /* déjà fermé */
      }
      this.socket = null;
    }
    this.setState('offline');
  }
}
