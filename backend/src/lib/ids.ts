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

/** Jour UTC au format YYYY-MM-DD. */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Prochain minuit UTC (instant de recharge du crédit). */
export function nextUtcMidnight(date: Date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0));
}

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
