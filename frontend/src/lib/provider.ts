/**
 * Provider Yjs maison sur WebSocket (API Gateway).
 *
 * Choix structurants :
 *  - **JSON + Base64** : le service refuse les trames binaires (code 1003) ;
 *  - **regroupement client** (`BATCH_MS`) : les frappes sont fusionnées en un
 *    seul update, ce qui divise le fan-out et le nombre d'invocations ;
 *  - **`opId` stable** : un update non acquitté est renvoyé à l'identique,
 *    donc jamais débité deux fois (C4) ni appliqué deux fois ;
 *  - **rattrapage `sinceSeq`** : toute modification acceptée est rejouable,
 *    donc aucune modification n'est perdue (C2).
 *
 * Repli HTTP automatique si le WebSocket ne peut pas s'ouvrir.
 */
import * as Y from 'yjs';

export type ProviderStatus = 'connecting' | 'connected' | 'reconnecting' | 'fallback' | 'closed';

export interface RemotePeer {
  email: string;
  name: string;
  color: string;
  cursor?: number | null;
}

export interface ProviderEvents {
  onStatus?: (status: ProviderStatus) => void;
  onPeers?: (peers: RemotePeer[]) => void;
  onCreditError?: (payload: { code: string; message: string; blockedUntil?: string }) => void;
  onAck?: (seq: number) => void;
  onError?: (message: string) => void;
}

interface PendingUpdate {
  opId: string;
  update: Uint8Array;
  attempts: number;
}

export interface ProviderOptions {
  docId: string;
  wsBase: string;
  apiBase: string;
  token: string;
  batchMs?: number;
  events?: ProviderEvents;
}

const BASE64_SAFE_LIMIT = 16 * 1024;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function newOpId(): string {
  const random = crypto.getRandomValues(new Uint8Array(9));
  return `op_${Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class YjsWebSocketProvider {
  readonly doc: Y.Doc;
  private options: ProviderOptions;
  private socket: WebSocket | null = null;
  private status: ProviderStatus = 'closed';
  private buffer: Uint8Array[] = [];
  private queue: PendingUpdate[] = [];
  private inflight = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closedByUser = false;
  private synced = false;
  private lastSeq = 0;
  private peers = new Map<string, RemotePeer>();
  private readOnly = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(doc: Y.Doc, options: ProviderOptions) {
    this.doc = doc;
    this.options = options;
    this.doc.on('update', this.handleLocalUpdate);
    this.connect();
  }

  // --- cycle de vie -------------------------------------------------------
  private setStatus(status: ProviderStatus): void {
    this.status = status;
    this.options.events?.onStatus?.(status);
  }

  private async connect(): Promise<void> {
    if (this.closedByUser) return;
    this.setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    try {
      const response = await fetch(`${this.options.apiBase}/ws-ticket`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify({ docId: this.options.docId }),
      });
      if (!response.ok) throw new Error(`Ticket refusé (${response.status})`);
      const { ticket } = (await response.json()) as { ticket: string };

      const url = `${this.options.wsBase}?ticket=${encodeURIComponent(ticket)}`;
      const socket = new WebSocket(url);
      socket.onopen = () => this.handleOpen();
      socket.onmessage = (event) => this.handleMessage(event);
      socket.onerror = () => this.handleClose();
      socket.onclose = () => this.handleClose();
      this.socket = socket;
    } catch (error) {
      this.options.events?.onError?.((error as Error).message);
      // Le WebSocket est indisponible : on bascule en repli HTTP **tout de
      // suite**, sans attendre une reconnexion. Sans cela, le drapeau `synced`
      // resterait faux et aucune écriture ne partirait jamais.
      this.setStatus('fallback');
      await this.catchUp();
      this.startFallbackPolling();
      this.flush();
      this.scheduleReconnect();
    }
  }

  private handleOpen(): void {
    this.reconnectAttempts = 0;
    this.setStatus('connected');
    this.stopFallbackPolling();
    void this.catchUp();
    this.flush();
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
    if (this.closedByUser) return;
    this.setStatus('reconnecting');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(15000, 500 * 2 ** Math.min(this.reconnectAttempts, 5)) + Math.random() * 400;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** Rattrapage : tout update accepté après `lastSeq` est rejoué (C2). */
  private async catchUp(): Promise<void> {
    try {
      const response = await fetch(
        `${this.options.apiBase}/documents/${this.options.docId}/updates?since=${this.lastSeq}`,
        { headers: { authorization: `Bearer ${this.options.token}` } },
      );
      if (!response.ok) return;
      const data = (await response.json()) as { updates: Array<{ seq: number; payload: string }> };
      for (const update of data.updates) {
        if (update.seq <= this.lastSeq) continue;
        Y.applyUpdate(this.doc, fromBase64(update.payload), 'remote');
        this.lastSeq = update.seq;
      }
      this.synced = true;
    } catch {
      this.synced = false;
    }
  }

  // --- messages entrants --------------------------------------------------
  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') {
      // Trame binaire : jamais acceptée par le service, on ignore proprement.
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(message.type ?? '');

    if (type === 'joined') {
      this.lastSeq = Number(message.seq ?? 0);
      void this.catchUp();
      return;
    }

    if (type === 'update' && typeof message.payload === 'string') {
      const seq = Number(message.seq ?? 0);
      if (seq > this.lastSeq) {
        Y.applyUpdate(this.doc, fromBase64(message.payload), 'remote');
        this.lastSeq = seq;
      }
      return;
    }

    if (type === 'ack') {
      this.acknowledge(String(message.opId ?? ''));
      this.options.events?.onAck?.(Number(message.seq ?? 0));
      return;
    }

    if (type === 'error') {
      const code = String(message.code ?? 'ERROR');
      const text = String(message.message ?? code);
      if (code === 'CREDIT_EXHAUSTED') {
        this.readOnly = true;
        this.queue = [];
        this.buffer = [];
        this.options.events?.onCreditError?.({
          code,
          message: text,
          blockedUntil: typeof message.blockedUntil === 'string' ? message.blockedUntil : undefined,
        });
        return;
      }
      if (code === 'BLOCKED') {
        this.readOnly = true;
        this.queue = [];
        this.buffer = [];
        this.options.events?.onCreditError?.({ code, message: text });
        return;
      }
      if (code === 'PAYLOAD_TOO_LARGE') {
        // Un update trop gros est abandonné : il serait rejeté indéfiniment.
        this.queue = [];
        this.options.events?.onError?.('Modification trop volumineuse, découpez-la (une seconde de frappe maximum).');
        return;
      }
      const opId = typeof message.opId === 'string' ? message.opId : '';
      if (opId) this.acknowledge(opId);
      this.options.events?.onError?.(text);
      return;
    }

    if (type === 'presence' && Array.isArray(message.people)) {
      this.peers.clear();
      for (const person of message.people as RemotePeer[]) {
        this.peers.set(person.email, person);
      }
      this.options.events?.onPeers?.([...this.peers.values()]);
      return;
    }

    if (type === 'awareness') {
      const email = String(message.email ?? '');
      if (!email) return;
      this.peers.set(email, {
        email,
        name: String(message.name ?? email),
        color: String(message.color ?? '#2563eb'),
        cursor: typeof message.cursor === 'number' ? message.cursor : null,
      });
      this.options.events?.onPeers?.([...this.peers.values()]);
    }
  }

  private acknowledge(opId: string): void {
    this.queue = this.queue.filter((entry) => entry.opId !== opId);
    this.inflight = false;
    this.flush();
  }

  // --- messages sortants --------------------------------------------------
  private handleLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === 'remote' || origin === 'restore') return;
    if (this.readOnly) {
      this.options.events?.onError?.('Crédit épuisé : la modification n\'a pas été envoyée.');
      return;
    }
    this.buffer.push(update);
    if (this.flushTimer) return;
    const delay = this.options.batchMs ?? 300;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
  };

  private flush(): void {
    if (this.inflight || this.readOnly) return;
    // On ne dépend pas de `synced` : l'éditeur a déjà chargé l'état complet via
    // `GET /documents/{id}/state`, et les updates Yjs sont commutatifs. Bloquer
    // ici empêcherait toute écriture en repli HTTP (WebSocket indisponible).

    if (this.buffer.length > 0) {
      const merged = Y.mergeUpdates(this.buffer);
      this.buffer = [];
      if (merged.length > BASE64_SAFE_LIMIT) {
        this.options.events?.onError?.('Modification trop volumineuse pour un envoi unique.');
        return;
      }
      this.queue.push({ opId: newOpId(), update: merged, attempts: 0 });
    }

    const next = this.queue.shift();
    if (!next) return;
    this.queue.unshift(next);
    this.send(next);
  }

  private send(entry: PendingUpdate): void {
    const payload = toBase64(entry.update);
    entry.attempts++;

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.inflight = true;
      this.socket.send(JSON.stringify({ type: 'update', opId: entry.opId, payload }));
      // Garde-fou : sans ack, on renvoie le MÊME opId (déduplication serveur).
      setTimeout(() => {
        if (this.inflight && this.queue[0]?.opId === entry.opId) {
          this.inflight = false;
          if (entry.attempts < 4) this.send(entry);
        }
      }, 4000);
      return;
    }

    void this.sendOverHttp(entry);
  }

  /** Repli HTTP : mêmes opId, mêmes règles serveur, donc même garantie C2/C4. */
  private async sendOverHttp(entry: PendingUpdate): Promise<void> {
    this.setStatus(this.status === 'connected' ? 'connected' : 'fallback');
    try {
      const response = await fetch(`${this.options.apiBase}/documents/${this.options.docId}/updates`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify({ opId: entry.opId, update: toBase64(entry.update) }),
      });
      const data = (await response.json()) as {
        ack?: { seq: number };
        error?: { code: string; message: string; blockedUntil?: string };
      };
      if (!response.ok) {
        const code = data.error?.code ?? 'ERROR';
        if (code === 'CREDIT_EXHAUSTED' || code === 'BLOCKED') {
          this.readOnly = true;
          this.queue = [];
          this.options.events?.onCreditError?.({
            code,
            message: data.error?.message ?? code,
            blockedUntil: data.error?.blockedUntil,
          });
          return;
        }
        throw new Error(data.error?.message ?? `HTTP ${response.status}`);
      }
      this.acknowledge(entry.opId);
      this.options.events?.onAck?.(Number(data.ack?.seq ?? 0));
      this.startFallbackPolling();
    } catch (error) {
      this.options.events?.onError?.((error as Error).message);
      if (entry.attempts < 6) {
        setTimeout(() => void this.sendOverHttp(entry), Math.min(5000, 300 * entry.attempts) + Math.random() * 200);
      }
    }
  }

  private startFallbackPolling(): void {
    if (this.pollTimer || this.status === 'connected') return;
    this.pollTimer = setInterval(() => {
      void this.catchUp();
    }, 1500);
  }

  private stopFallbackPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Envoie la présence (curseur) — non persistée, non facturée. */
  sendAwareness(cursor: number | null): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'awareness', cursor }));
    }
  }

  /** Interdit l'écriture côté client (crédit épuisé) sans casser la lecture. */
  setReadOnly(value: boolean): void {
    this.readOnly = value;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  destroy(): void {
    this.closedByUser = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopFallbackPolling();
    this.doc.off('update', this.handleLocalUpdate);
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
    this.setStatus('closed');
  }
}
