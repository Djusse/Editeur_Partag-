/**
 * Utilitaires d'identifiants, d'horloge UTC et de couleurs de présence.
 * Toutes les dates métier (crédit, blocage) sont calculées en UTC.
 */
import { createHash, randomBytes } from 'crypto';

export function randomToken(bytes = 18): string {
  return randomBytes(bytes).toString('base64url');
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
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0));
  return next;
}

export function secondsUntilUtcMidnight(date: Date = new Date()): number {
  return Math.max(1, Math.floor((nextUtcMidnight(date).getTime() - date.getTime()) / 1000));
}

const PALETTE = ['#2563eb', '#db2777', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#dc2626', '#65a30d', '#c026d3', '#ea580c'];

/** Couleur stable par rédacteur, pour les curseurs distants. */
export function colorFor(identity: string): string {
  const digest = createHash('sha1').update(identity).digest();
  return PALETTE[digest[0] % PALETTE.length];
}

export function clampText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}

/** Aléa borné, utilisé pour les backoffs avec jitter. */
export function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}
