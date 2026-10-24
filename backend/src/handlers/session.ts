/** POST /session : nom + e-mail → JWT (identité légère, sans mot de passe). */
import { badRequest } from '../lib/errors';
import { clampText, isValidEmail } from '../lib/ids';
import { signSession } from '../lib/jwt';
import { httpHandler, json, type RequestContext } from '../lib/http';
import { getCredit } from '../lib/credits';

interface Body {
  name?: string;
  email?: string;
}

export const handler = httpHandler(async (ctx: RequestContext) => {
  const body = (ctx.body ?? {}) as Body;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name = clampText(body.name, 80);
  if (!isValidEmail(email)) throw badRequest('INVALID_EMAIL', 'Adresse e-mail invalide');
  if (!name) throw badRequest('INVALID_NAME', 'Le nom est obligatoire');

  const token = await signSession({ email, name });
  const credit = await getCredit(email);
  return json(200, {
    token,
    session: { email, name, role: 'editor' },
    credit,
  });
});
