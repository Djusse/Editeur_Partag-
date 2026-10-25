/**
 * Identifiants, horloge UTC, couleurs de présence.
 *
 * Les couleurs suivent **exactement** la palette de la spécification
 * d'interface (hash de l'e-mail modulo 8) : le front calcule la même chose
 * pour ses pastilles, donc les deux affichages concordent.
 */
import { createHash, randomBytes } from 'node:crypto';

export function randomToken(bytes = 18): string {
  return randomBytes(bytes).toString('base64url');
}

/** Identifiant de document, court et lisible. */
export function newDocId(): string {
  return `doc_${randomToken(9)}`;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Décalage du fuseau métier, en minutes.
 *
 * Le crédit d'écriture est calé sur le **jour de Douala** (UTC+1), et non sur
 * le jour UTC : l'utilisateur voyait « recharge à 01:00 » alors qu'il lui
 * semblait évident que la remise à zéro devait tomber à minuit chez lui.
 *
 * Le fuseau est fixé en dur plutôt que déduit de `process.env.TZ` : le serveur
 * de production tourne en UTC, et l'on veut que le comportement soit identique
 * en local, en test et sur EC2. Le Cameroun n'applique pas d'heure d'été, le
 * décalage est donc constant et l'arithmétique reste exacte toute l'année.
 */
export const BUSINESS_UTC_OFFSET_MINUTES = 60;

const BUSINESS_OFFSET_MS = BUSINESS_UTC_OFFSET_MINUTES * 60_000;

/** Instant courant décalé dans le fuseau métier. */
function shifted(date: Date): Date {
  return new Date(date.getTime() + BUSINESS_OFFSET_MS);
}

/**
 * Jour métier (Douala) au format YYYY-MM-DD.
 *
 * C'est la clé de partition du crédit : elle change à 23:00 UTC, soit minuit
 * à Douala. Deux écritures séparées par cette limite sont facturées sur deux
 * journées différentes, ce qui est exactement le comportement attendu.
 */
export function utcDay(date: Date = new Date()): string {
  return shifted(date).toISOString().slice(0, 10);
}

/** Prochain minuit à Douala (instant de recharge du crédit). */
export function nextUtcMidnight(date: Date = new Date()): Date {
  const local = shifted(date);
  const nextLocalMidnight = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return new Date(nextLocalMidnight.getTime() - BUSINESS_OFFSET_MS);
}

/** Secondes restantes avant la recharge (minuit à Douala). */
export function secondsUntilUtcMidnight(date: Date = new Date()): number {
  return Math.max(1, Math.floor((nextUtcMidnight(date).getTime() - date.getTime()) / 1000));
}

/** Palette imposée par la spécification d'interface (section 1.2). */
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

/** Couleur stable par e-mail : hash modulo 8, comme le front. */
export function colorFor(email: string): string {
  const digest = createHash('sha1').update(email.toLowerCase()).digest();
  return PRESENCE_COLORS[digest[0] % PRESENCE_COLORS.length];
}

export function clampText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}

/** Aléa borné, pour les backoffs avec gigue. */
export function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
