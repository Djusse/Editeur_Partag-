/**
 * Crédit d'écriture (C4) et anti-abus.
 *
 * Règles :
 *  - 10 000 caractères par e-mail et par jour UTC, insertions **et**
 *    suppressions comptées ;
 *  - le compteur est unique par (e-mail, jour) : plusieurs appareils partagent
 *    donc le même quota ;
 *  - 4 refus pour crédit épuisé dans la journée → blocage jusqu'au prochain
 *    minuit UTC ; la lecture reste possible.
 */
import { config } from './config';
import { getItem, putItem, updateItem } from './db';
import { ErrorCodes, ApiError } from './errors';
import { secondsUntilUtcMidnight, utcDay } from './ids';
import type { AbuseRow, CreditRow } from './types';

const CREDIT_TTL_SECONDS = 48 * 3600;

export function creditId(email: string, day = utcDay()): string {
  return `${email}#${day}`;
}

export function abuseId(email: string, day = utcDay()): string {
  return `${email}#${day}`;
}

export async function getCredit(email: string): Promise<{ used: number; limit: number; remaining: number; day: string; resetsIn: number }> {
  const day = utcDay();
  const row = await getItem<CreditRow>(config().creditsTable, { id: creditId(email, day) });
  const limit = row?.limit ?? config().creditPerDay;
  const used = row?.used ?? 0;
  return { used, limit, remaining: Math.max(0, limit - used), day, resetsIn: secondsUntilUtcMidnight() };
}

/** Lève une erreur BLOCKED si l'utilisateur est bloqué pour la journée. */
export async function assertNotBlocked(email: string, now = new Date()): Promise<void> {
  const row = await getItem<AbuseRow>(config().abuseTable, { id: abuseId(email, utcDay(now)) });
  if (!row?.blockedUntil) return;
  const until = new Date(row.blockedUntil);
  if (until.getTime() > now.getTime()) {
    throw new ApiError(403, ErrorCodes.blocked, 'Écriture bloquée après trop de refus de crédit', {
      blockedUntil: row.blockedUntil,
      retryAfter: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
    });
  }
}

/**
 * Enregistre un refus pour crédit épuisé. Un même `opId` rejoué n'est compté
 * qu'une fois (marqueur conditionnel `REFUSED#email#opId` dans la table OpIds).
 */
export async function recordCreditRefusal(email: string, opId: string): Promise<{ refusals: number; blockedUntil?: string }> {
  const day = utcDay();
  const markerId = `REFUSED#${email}#${opId}`;
  const ttl = Math.floor(Date.now() / 1000) + CREDIT_TTL_SECONDS;
  try {
    await putItem(
      config().opIdsTable,
      { id: markerId, email, docId: '', hash: '', seq: -1, ttl },
      { condition: 'attribute_not_exists(id)' },
    );
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
      const current = await getItem<AbuseRow>(config().abuseTable, { id: abuseId(email, day) });
      return { refusals: current?.refusals ?? 0, blockedUntil: current?.blockedUntil };
    }
    throw error;
  }

  const updated = await updateItem(
    config().abuseTable,
    { id: abuseId(email, day) },
    {
      update: 'ADD refusals :one SET email = :email, #day = :day, #ttl = :ttl',
      names: { '#day': 'day', '#ttl': 'ttl' },
      values: { ':one': 1, ':email': email, ':day': day, ':ttl': ttl },
    },
  );
  const refusals = Number(updated?.refusals ?? 1);
  if (refusals >= config().blockAfterRefusals) {
    const blockedUntil = new Date(Date.UTC(...nextMidnightParts()));
    await updateItem(
      config().abuseTable,
      { id: abuseId(email, day) },
      {
        update: 'SET blockedUntil = :until',
        values: { ':until': blockedUntil.toISOString() },
      },
    );
    return { refusals, blockedUntil: blockedUntil.toISOString() };
  }
  return { refusals };
}

function nextMidnightParts(): [number, number, number, number, number, number, number] {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return [
    next.getUTCFullYear(),
    next.getUTCMonth(),
    next.getUTCDate(),
    0,
    0,
    0,
    0,
  ];
}

/** Liste des personnes bloquées (supervision). */
export async function listBlocked(rows: AbuseRow[]): Promise<AbuseRow[]> {
  const now = Date.now();
  return rows.filter((row) => row.blockedUntil && new Date(row.blockedUntil).getTime() > now);
}
