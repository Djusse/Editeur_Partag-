/**
 * Secrets lus dans SSM Parameter Store (SecureString).
 *
 * En production, l'instance les récupère au démarrage avec son **rôle
 * d'instance** (identifiants temporaires, aucune clé d'accès dans le code ni
 * dans le user data). Ils sont ensuite mis en cache pour la vie du processus.
 *
 * En mode local, aucun appel AWS : les valeurs sont générées en mémoire.
 */
import { randomBytes } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { config } from './config';

const cache = new Map<string, string>();
let overrides: Record<string, string> | null = null;
let client: SSMClient | null = null;

/** Réservé aux tests et au mode local. */
export function setSecretOverrides(values: Record<string, string> | null): void {
  overrides = values;
  cache.clear();
}

/** Génère des secrets éphémères pour le mode local. */
export function generateLocalSecrets(): Record<string, string> {
  return {
    jwt: randomBytes(32).toString('base64url'),
    admin: randomBytes(16).toString('base64url'),
  };
}

async function readParameter(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;

  if (overrides) {
    const value = name.endsWith('admin-key') ? overrides.admin : overrides.jwt;
    cache.set(name, value);
    return value;
  }

  if (!client) client = new SSMClient({ region: config().region });
  const result = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = result.Parameter?.Value;
  if (!value) throw new Error(`Paramètre SSM introuvable : ${name}`);
  cache.set(name, value);
  return value;
}

export function jwtSecret(): Promise<string> {
  return readParameter(config().jwtSecretParam);
}

export function adminKey(): Promise<string> {
  return readParameter(config().adminKeyParam);
}
