/** Client HTTP de l'API (JWT en mémoire + localStorage). */

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '').replace(/\/$/, '');
const TOKEN_KEY = 'editeur.session.token';
const PROFILE_KEY = 'editeur.session.profile';

export interface Profile {
  email: string;
  name: string;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, payload: ApiErrorShape) {
    super(payload.message ?? payload.code);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.code;
    this.details = payload;
  }
}

export function apiBase(): string {
  return API_BASE;
}

export function wsUrl(): string {
  return process.env.NEXT_PUBLIC_WS_URL ?? '';
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getProfile(): Profile | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Profile;
  } catch {
    return null;
  }
}

export function setSession(token: string, profile: Profile): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(PROFILE_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await response.text();
  const payload = text ? safeJson(text) : {};

  if (!response.ok) {
    const error = (payload as { error?: ApiErrorShape }).error ?? { code: 'HTTP_ERROR', message: text || `HTTP ${response.status}` };
    throw new ApiError(response.status, error);
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export const api = {
  async createSession(name: string, email: string) {
    return request<{ token: string; session: Profile; credit: CreditInfo }>('/session', {
      method: 'POST',
      body: JSON.stringify({ name, email }),
    });
  },

  async listDocuments() {
    return request<{ documents: DocumentSummary[] }>('/documents');
  },

  async createDocument(title: string) {
    return request<{ document: DocumentSummary }>('/documents', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  },

  async getDocument(docId: string) {
    return request<DocumentDetail>(`/documents/${docId}`);
  },

  async renameDocument(docId: string, title: string) {
    return request<{ ok: boolean }>(`/documents/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  },

  async deleteDocument(docId: string) {
    return request<{ ok: boolean }>(`/documents/${docId}`, { method: 'DELETE' });
  },

  async addMember(docId: string, email: string, name: string) {
    return request<{ member: Member }>(`/documents/${docId}/members`, {
      method: 'POST',
      body: JSON.stringify({ email, name }),
    });
  },

  async createLink(docId: string, maxDownloads: number) {
    return request<{ link: LinkSummary & { path: string } }>(`/documents/${docId}/links`, {
      method: 'POST',
      body: JSON.stringify({ maxDownloads }),
    });
  },

  async getState(docId: string) {
    return request<DocumentState>(`/documents/${docId}/state`);
  },

  async listUpdates(docId: string, since: number) {
    return request<{ updates: WireUpdate[] }>(`/documents/${docId}/updates?since=${since}`);
  },

  async postUpdate(docId: string, opId: string, payload: string) {
    return request<{ ack: { opId: string; seq: number; duplicate: boolean; chars: number } }>(
      `/documents/${docId}/updates`,
      { method: 'POST', body: JSON.stringify({ opId, update: payload }) },
    );
  },

  async getCredit() {
    return request<CreditInfo>('/me/credit');
  },

  async listVersions(docId: string) {
    return request<{ currentSeq: number; versions: VersionSummary[] }>(`/documents/${docId}/versions`);
  },

  async createVersion(docId: string) {
    return request<{ version: { n: number; chars: number; createdAt: string } }>(`/documents/${docId}/versions`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async restoreVersion(docId: string, n: number) {
    return request<{ restored: number; seq: number }>(`/documents/${docId}/versions/${n}/restore`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async wsTicket(docId: string) {
    return request<{ ticket: string; expiresIn: number; docId: string }>('/ws-ticket', {
      method: 'POST',
      body: JSON.stringify({ docId }),
    });
  },

  async adminState(adminKey: string) {
    const response = await fetch(`${API_BASE}/admin/state`, { headers: { 'x-admin-key': adminKey } });
    const text = await response.text();
    const payload = text ? safeJson(text) : {};
    if (!response.ok) {
      const error = (payload as { error?: ApiErrorShape }).error ?? { code: 'HTTP_ERROR', message: text };
      throw new ApiError(response.status, error);
    }
    return payload as AdminState;
  },

  // --- Parcours visiteur (aucune authentification) ---
  async linkStatus(token: string) {
    return request<LinkStatus>(`/d/${token}/status`);
  },

  async claim(token: string, visitorId: string) {
    return rawRequest<ClaimResponse>(`/d/${token}/claim`, {
      method: 'POST',
      body: JSON.stringify({ visitorId }),
    });
  },

  async file(token: string, visitorId: string) {
    return rawRequest<ClaimResponse>(`/d/${token}/file?visitorId=${encodeURIComponent(visitorId)}`);
  },
};

/** Pour le visiteur : on ne lève pas d'exception sur 410/202, ce sont des états. */
async function rawRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : {};
  return { ...(payload as object), httpStatus: response.status } as T;
}

// --- Types partagés avec l'API ---
export interface CreditInfo {
  used: number;
  limit: number;
  remaining: number;
  day: string;
  resetsIn: number;
  blocked?: boolean;
  blockedUntil?: string;
  refusals?: number;
}

export interface DocumentSummary {
  docId: string;
  title: string;
  ownerEmail: string;
  ownerName: string;
  seq: number;
  textLength: number;
  createdAt: string;
  updatedAt: string;
  role?: string;
}

export interface Member {
  docId: string;
  email: string;
  name: string;
  role: 'owner' | 'editor';
  addedAt: string;
}

export interface LinkSummary {
  token: string;
  maxDownloads: number;
  remaining: number;
  status: 'ACTIVE' | 'EXHAUSTED';
  createdAt?: string;
}

export interface DocumentDetail {
  document: DocumentSummary;
  role: string;
  members: Member[];
  links: LinkSummary[];
}

export interface WireUpdate {
  seq: number;
  author: string;
  authorName?: string;
  opId?: string;
  payload: string;
  createdAt?: string;
}

export interface DocumentState {
  document: { docId: string; title: string; seq: number; textLength: number };
  seq: number;
  snapshot: string | null;
  updates: WireUpdate[];
}

export interface VersionSummary {
  n: number;
  chars: number;
  createdAt: string;
  authorName: string;
  label: string;
}

export interface LinkStatus {
  status: 'active' | 'exhausted';
  remaining: number;
  maxDownloads: number;
  docTitle: string;
}

export interface ClaimResponse {
  state: 'ready' | 'waiting' | 'exhausted';
  url?: string;
  remaining: number;
  retryAfter?: number;
  seq?: number;
  message?: string;
  code?: string;
  httpStatus?: number;
}

export interface AdminState {
  generatedAt: string;
  totals: { documents: number; openDocuments: number; connections: number };
  openDocuments: Array<{
    docId: string;
    title: string;
    seq: number;
    readers: number;
    links: Array<{ token: string; status: string; remaining: number; maxDownloads: number }>;
  }>;
  activeLinks: number;
  creditToday: Array<{ email: string; used: number; limit: number }>;
  blocked: Array<{ email: string; blockedUntil: string; refusals: number }>;
}
