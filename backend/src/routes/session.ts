/** POST /api/session : nom + e-mail → JWT (aucun mot de passe). */
import type { FastifyInstance } from 'fastify';
import { invalidInput } from '../lib/errors';
import { clampText, isValidEmail } from '../lib/ids';
import { signSession } from '../lib/jwt';
import { NAME_MAX } from '../lib/documents';
import { getCreditState } from '../lib/credits';

export function registerSessionRoutes(app: FastifyInstance): void {
  app.post('/session', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; email?: unknown };
    const name = clampText(body.name, NAME_MAX);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!name) throw invalidInput('name', 'Entrez votre nom (60 caractères maximum).');
    if (!isValidEmail(email)) throw invalidInput('email', 'Adresse e-mail invalide.');

    const token = await signSession(email, name);
    const credit = await getCreditState(email);
    reply.code(200);
    return { token, user: { name, email }, credit };
  });
}
