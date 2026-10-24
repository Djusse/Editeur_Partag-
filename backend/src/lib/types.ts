/**
 * Modèle de données (plan v7, section 2.2).
 *
 * La présence, les connexions WebSocket et les tickets WebSocket vivent
 * **en mémoire** : une seule instance applicative, donc pas de table
 * `Connections`.
 */

export interface DocumentRow {
  docId: string;
  title: string;
  ownerEmail: string;
  ownerName: string;
  /** Dernier `seq` écrit dans le journal. */
  seq: number;
  latestSnapshotSeq: number;
  textLength: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemberRow {
  docId: string;
  email: string;
  name: string;
  role: 'owner' | 'editor';
  addedAt: string;
}

/** Une entrée de journal = un groupe d'updates fusionnés. */
export interface UpdateRow {
  docId: string;
  seq: number;
  /** Update Yjs fusionné, stocké en binaire. */
  payload: Uint8Array;
  /** Détail des updates du groupe (traçabilité et tests). */
  ops: Array<{ opId: string; authorEmail: string; chars: number }>;
  chars: number;
  createdAt: string;
}

export type LinkStatus = 'ACTIVE' | 'EXHAUSTED';

export interface LinkRow {
  token: string;
  docId: string;
  docTitle: string;
  createdByEmail: string;
  createdByName: string;
  maxDownloads: number;
  remaining: number;
  status: LinkStatus;
  notified: boolean;
  createdAt: string;
}

export interface TicketRow {
  token: string;
  visitorId: string;
  docId: string;
  /** Version figée au moment du claim : c'est T1. */
  seqFrozen: number;
  createdAt: string;
  ttl: number;
}

export interface CreditRow {
  id: string;
  email: string;
  day: string;
  used: number;
  limit: number;
  ttl: number;
}

export interface OpIdRow {
  id: string;
  hash: string;
  seq: number;
  email: string;
  docId: string;
  ttl: number;
}

export interface AbuseRow {
  id: string;
  email: string;
  day: string;
  refusals: number;
  blockedUntil?: string;
  ttl: number;
}

export type PdfStatus = 'BUILDING' | 'READY' | 'FAILED';

export interface PdfCacheRow {
  id: string;
  docId: string;
  seq: number;
  status: PdfStatus;
  s3Key?: string;
  attempts?: number;
  error?: string;
  createdAt: string;
  /** Date du bail : permet de relancer une génération abandonnée. */
  leaseUntil?: number;
  ttl: number;
}

export interface VersionRow {
  docId: string;
  n: number;
  s3Key: string;
  authorEmail: string;
  authorName: string;
  chars: number;
  createdAt: string;
}

/** Ticket WebSocket : uniquement en mémoire. */
export interface WsTicket {
  ticket: string;
  email: string;
  name: string;
  docId: string;
  exp: number;
}
