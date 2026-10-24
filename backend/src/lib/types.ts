/** Types partagés du modèle de données DynamoDB (cf. dossier de conception §2.2). */

export interface DocumentRow {
  docId: string;
  title: string;
  ownerEmail: string;
  ownerName: string;
  seq: number;
  latestSnapshotSeq: number;
  textLength: number;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}

export interface MemberRow {
  docId: string;
  email: string;
  role: 'owner' | 'editor';
  name: string;
  addedAt: string;
}

export interface UpdateRow {
  docId: string;
  seq: number;
  payload: Uint8Array;
  authorEmail: string;
  authorName: string;
  opId: string;
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

export interface ConnectionRow {
  connectionId: string;
  docId: string;
  email: string;
  name: string;
  color: string;
  cursor?: number | null;
  joinedAt: string;
  ttl: number;
}

export interface WsTicketRow {
  ticket: string;
  email: string;
  name: string;
  docId: string;
  exp: number;
  used: boolean;
  ttl: number;
}

export type PdfStatus = 'BUILDING' | 'READY' | 'FAILED';

export interface PdfCacheRow {
  id: string;
  docId: string;
  seq: number;
  status: PdfStatus;
  s3Key?: string;
  error?: string;
  /** Nombre de tentatives de génération (pour ne pas boucler indéfiniment). */
  attempts?: number;
  createdAt: string;
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
