/**
 * JWT HS256 minimal (aucune dépendance externe). Le secret est lu dans SSM
 * Parameter Store et mis en cache pour la durée de vie du conteneur Lambda.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { config } from './config';
import { unauthorized } from './errors';

export type Role = 'editor' | 'admin';

export interface Session {
  email: string;
  name: string;
  role: Role;
  iat: number;
  exp: number;
}

let ssm: SSMClient | null = null;
const cache = new Map<string, string>();

/**
 * Lit un paramètre SSM. S'il n'existe pas (premier déploiement), l'application
 * le **crée** avec une valeur aléatoire forte : aucun secret n'est présent dans
 * le dépôt, et le déploiement reste en une seule commande.
 */
async function readParameter(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;
  if (!ssm) ssm = new SSMClient({ region: config().region });

  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = result.Parameter?.Value;
    if (value) {
      cache.set(name, value);
      return value;
    }
  } catch (error) {
    const code = (error as { name?: string }).name;
    if (code !== 'ParameterNotFound') throw error;
  }

  const generated = randomBytes(32).toString('base64url');
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Value: generated,
        Type: 'SecureString',
        Overwrite: false,
        Description: 'Secret généré automatiquement par l\'application (ne pas committer).',
      }),
    );
    cache.set(name, generated);
    return generated;
  } catch (error) {
    // Course entre deux conteneurs froids : l'autre a gagné, on relit.
    const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const value = result.Parameter?.Value;
    if (!value) throw error;
    cache.set(name, value);
    return value;
  }
}

export async function jwtSecret(): Promise<string> {
  return readParameter(config().jwtSecretParam);
}

export async function adminKey(): Promise<string> {
  return readParameter(config().adminKeyParam);
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export async function signSession(
  identity: { email: string; name: string; role?: Role },
  ttlSeconds = config().sessionTtlSeconds,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Session = {
    email: identity.email,
    name: identity.name,
    role: identity.role ?? 'editor',
    iat: now,
    exp: now + ttlSeconds,
  };
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const secret = await jwtSecret();
  return `${header}.${body}.${signature(`${header}.${body}`, secret)}`;
}

export async function verifySession(token: string | undefined | null): Promise<Session> {
  if (!token) throw unauthorized('MISSING_TOKEN', 'Jeton absent');
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('INVALID_TOKEN', 'Jeton malformé');
  const [header, body, mac] = parts;
  const secret = await jwtSecret();
  const expected = signature(`${header}.${body}`, secret);
  const macBuffer = Buffer.from(mac);
  const expectedBuffer = Buffer.from(expected);
  if (macBuffer.length !== expectedBuffer.length || !timingSafeEqual(macBuffer, expectedBuffer)) {
    throw unauthorized('INVALID_TOKEN', 'Signature invalide');
  }
  let payload: Session;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
  } catch {
    throw unauthorized('INVALID_TOKEN', 'Charge utile illisible');
  }
  if (!payload.exp || payload.exp * 1000 <= Date.now()) {
    throw unauthorized('TOKEN_EXPIRED', 'Session expirée, reconnectez-vous');
  }
  return payload;
}
