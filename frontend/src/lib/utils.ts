/**
 * Utilitaires imposés par la spécification d'interface (section 2.4).
 *
 * L'application est servie en **HTTP sur une IP nue** : ce n'est pas un
 * « contexte sécurisé » pour le navigateur. `crypto.randomUUID()` et
 * `navigator.clipboard` sont donc **interdits** — ils n'existent pas dans ce
 * contexte et lèveraient une exception.
 */

/** UUID v4 sans `crypto.randomUUID` (fonctionne en HTTP). */
export function uuidv4(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Copie sans `navigator.clipboard` (fonctionne en HTTP). */
export function copyText(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const element = document.createElement('textarea');
  element.value = text;
  element.setAttribute('readonly', '');
  element.style.position = 'fixed';
  element.style.opacity = '0';
  document.body.appendChild(element);
  element.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(element);
  return ok;
}

/**
 * URL WebSocket déduite de `location`, jamais écrite en dur.
 *
 * En production, le front et l'API partagent la même origine (nginx) : l'URL
 * est donc strictement celle de la page courante, en `ws:` ou `wss:`.
 * En développement uniquement, `NEXT_PUBLIC_WS_BASE` permet de viser un autre
 * port (le serveur Node local) sans modifier ce comportement.
 */
export function wsUrl(ticket: string, documentId: string): string {
  const override = process.env.NEXT_PUBLIC_WS_BASE;
  const base =
    override ??
    `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
  return `${base}?ticket=${encodeURIComponent(ticket)}&documentId=${encodeURIComponent(documentId)}`;
}

/**
 * Adresse absolue d'un lien de téléchargement, construite côté front.
 * En production, `location.origin` est l'Elastic IP : l'adresse est donc
 * partageable telle quelle.
 */
export function linkUrl(token: string): string {
  return `${window.location.origin}/d?token=${encodeURIComponent(token)}`;
}

/** Nombre avec espace fine insécable, comme « 7 420 ». */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('fr-FR').format(value).replace(/\u202f|\u00a0/g, ' ');
}

const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Date et heure locales : « 24/10/2026 18:04 ». */
export function formatDateTime(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

/** Heure locale seule : « 18:04 ». */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

const relative = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

/** « il y a 3 minutes », « hier »… (fuseau du navigateur). */
export function formatRelative(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const minutes = Math.round(diffMs / 60000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return relative.format(days, 'day');
  return formatDateTime(iso);
}

/** Palette de présence imposée (hash de l'e-mail modulo 8), identique au serveur. */
export const PRESENCE_COLORS = [
  '#2563EB',
  '#DB2777',
  '#059669',
  '#D97706',
  '#7C3AED',
  '#0891B2',
  '#DC2626',
  '#4D7C0F',
] as const;

export function colorFor(email: string): string {
  let hash = 0;
  const normalized = email.trim().toLowerCase();
  for (let index = 0; index < normalized.length; index++) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

/** Initiale affichée dans la pastille de présence. */
export function initialOf(name: string, email: string): string {
  const source = name.trim() || email.trim();
  return (source[0] ?? '?').toUpperCase();
}

/** Validation d'e-mail identique au serveur (254 caractères maximum). */
export function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(value.trim());
}
