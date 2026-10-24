/**
 * JWT HS256 minimal, sans dépendance externe.
 *
 * L'identité est volontairement légère (nom + e-mail, sans mot de passe) :
 * c'est ce que le sujet autorise. La limite est documentée dans le dossier.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { unauthorized } from './errors';
import { jwtSecret } from './secrets';

export interface Session {
  email: string;
  name: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export async function signSession(email: string, name: string, ttlSeconds?: number): Promise<string> {
  const ttl = ttlSeconds ?? config().sessionTtlSeconds;
  const now = Math.floor(Date.now() / 1000);
  const session: Session = { email, name, iat: now, exp: now + ttl };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(session));
  const secret = await jwtSecret();
  return `${header}.${body}.${sign(`${header}.${body}`, secret)}`;
}

export async function verifySession(token: string | undefined): Promise<Session> {
  if (!token) throw unauthorized('Jeton absent');
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('Jeton malformé');
  const [header, body, mac] = parts;

  const secret = await jwtSecret();
  const expected = sign(`${header}.${body}`, secret);
  const received = Buffer.from(mac);
  const reference = Buffer.from(expected);
  if (received.length !== reference.length || !timingSafeEqual(received, reference)) {
    throw unauthorized('Signature invalide');
  }

  let session: Session;
  try {
    session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
  } catch {
    throw unauthorized('Charge utile illisible');
  }
  if (!session.exp || session.exp * 1000 <= Date.now()) {
    throw unauthorized('Session expirée, reconnectez-vous');
  }
  return session;
}

/** Extrait le jeton de l'en-tête `Authorization: Bearer …`. */
export function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}
