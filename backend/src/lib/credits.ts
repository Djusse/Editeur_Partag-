/**
 * Crédit d'écriture (C4) et anti-abus.
 *
 * Règles (plan v7, tableau 1.4) :
 *  - 10 000 caractères par e-mail et par **jour UTC**, insertions **et**
 *    suppressions comptées ;
 *  - compteur unique par (e-mail, jour) : plusieurs appareils partagent le quota ;
 *  - 4 refus pour crédit épuisé dans la journée → écriture bloquée jusqu'au
 *    prochain minuit UTC ; la lecture reste possible.
 *
 * Le crédit est débité dans la **même transaction** que l'écriture au journal.
 */
import { config } from './config';
import { db } from './db';
import { AppError, WsErrorCodes } from './errors';
import { nextUtcMidnight, secondsUntilUtcMidnight, utcDay } from './ids';
import type { AbuseRow, CreditRow } from './types';

const TTL_SECONDS = 48 * 3600;

export function creditId(email: string, day = utcDay()): string {
  return `${email}#${day}`;
}

export function abuseId(email: string, day = utcDay()): string {
  return `${email}#${day}`;
}

export interface CreditState {
  limit: number;
  used: number;
  remaining: number;
  day: string;
  /** `null` si l'utilisateur n'est pas bloqué. */
  blockedUntil: string | null;
  /** Prochain minuit UTC (instant de recharge). */
  resetsAt: string;
  resetsIn: number;
}

export async function getCreditState(email: string): Promise<CreditState> {
  const cfg = config();
  const day = utcDay();
  const [credit, abuse] = await Promise.all([
    db().get<CreditRow>(cfg.creditsTable, { id: creditId(email, day) }),
    db().get<AbuseRow>(cfg.abuseTable, { id: abuseId(email, day) }),
  ]);

  const limit = credit?.limit ?? cfg.creditPerDay;
  const used = credit?.used ?? 0;
  const blockedUntil =
    abuse?.blockedUntil && new Date(abuse.blockedUntil).getTime() > Date.now() ? abuse.blockedUntil : null;

  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    day,
    blockedUntil,
    resetsAt: nextUtcMidnight().toISOString(),
    resetsIn: secondsUntilUtcMidnight(),
  };
}

/** Lève `BLOCKED` si l'utilisateur est bloqué pour la journée en cours. */
export async function assertNotBlocked(email: string): Promise<void> {
  const state = await getCreditState(email);
  if (state.blockedUntil) {
    throw new AppError(403, WsErrorCodes.blocked, 'Écriture bloquée après trop de refus de crédit', {
      details: { blockedUntil: state.blockedUntil, resetsAt: state.resetsAt },
    });
  }
}

/**
 * Enregistre un refus pour crédit épuisé.
 *
 * Un même `opId` rejoué n'est compté qu'une fois (marqueur conditionnel dans
 * la table `OpIds`), sinon un client qui s'acharne en boucle se bloquerait
 * lui-même sans avoir réellement réessayé.
 */
export async function recordCreditRefusal(
  email: string,
  opId: string,
): Promise<{ refusals: number; blockedUntil: string | null }> {
  const cfg = config();
  const day = utcDay();
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const markerId = `REFUSED#${email}#${opId}`;

  try {
    await db().put(
      cfg.opIdsTable,
      { id: markerId, email, docId: '', hash: '', seq: -1, ttl },
      { condition: 'attribute_not_exists(id)' },
    );
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
      const current = await db().get<AbuseRow>(cfg.abuseTable, { id: abuseId(email, day) });
      return { refusals: current?.refusals ?? 0, blockedUntil: current?.blockedUntil ?? null };
    }
    throw error;
  }

  const updated = await db().update(
    cfg.abuseTable,
    { id: abuseId(email, day) },
    {
      update: 'ADD refusals :one SET email = :email, #day = :day, #ttl = :ttl',
      names: { '#day': 'day', '#ttl': 'ttl' },
      values: { ':one': 1, ':email': email, ':day': day, ':ttl': ttl },
    },
  );

  const refusals = Number(updated?.refusals ?? 1);
  if (refusals < cfg.blockAfterRefusals) return { refusals, blockedUntil: null };

  const blockedUntil = nextUtcMidnight().toISOString();
  await db().update(
    cfg.abuseTable,
    { id: abuseId(email, day) },
    { update: 'SET blockedUntil = :until', values: { ':until': blockedUntil } },
  );
  return { refusals, blockedUntil };
}
