/** GET /me/credit : crédit restant du jour et état de blocage. */
import { config } from '../lib/config';
import { abuseId, getCredit } from '../lib/credits';
import { getItem } from '../lib/db';
import { json, requireSession, type RequestContext, type ResponsePayload } from '../lib/http';
import { utcDay } from '../lib/ids';
import type { AbuseRow } from '../lib/types';

export async function handler(ctx: RequestContext): Promise<ResponsePayload> {
  const session = await requireSession(ctx);
  const credit = await getCredit(session.email);
  const abuse = await getItem<AbuseRow>(config().abuseTable, { id: abuseId(session.email, utcDay()) });
  const blocked = Boolean(abuse?.blockedUntil && new Date(abuse.blockedUntil).getTime() > Date.now());
  return json(200, {
    email: session.email,
    name: session.name,
    ...credit,
    blocked,
    blockedUntil: blocked ? abuse?.blockedUntil : undefined,
    refusals: abuse?.refusals ?? 0,
  });
}
