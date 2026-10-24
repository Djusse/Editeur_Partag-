/**
 * Persistance du mode local sur disque.
 *
 * Sans elle, chaque redémarrage du serveur efface documents, liens et tickets :
 * un lien copié devenait « inconnu » après un `npm run local`. C'est exactement
 * le symptôme observé en essai, et il n'a rien à voir avec une expiration.
 *
 * Choix : un unique fichier JSON, écrit de façon **atomique** (fichier
 * temporaire puis `rename`) et **débattu** (`debounce`) pour ne pas réécrire à
 * chaque frappe. Les buffers (updates Yjs, PDF) sont encodés en Base64.
 *
 * Ce mécanisme est réservé au développement : en production, la durabilité est
 * assurée par DynamoDB et S3.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { MemoryDatabase } from '../../test/helpers/memory-db';

interface Snapshot {
  version: 1;
  savedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
  objects: Record<string, { base64: string; type: string }>;
  /**
   * Secrets du mode local.
   *
   * Sans eux, chaque redémarrage invalidait **toutes les sessions** (signature
   * JWT) et changeait la clé d'administration : on croyait à une déconnexion
   * ou à un bug, alors que seul le secret avait été régénéré.
   */
  secrets?: { jwt: string; admin: string };
}

const FLUSH_DELAY_MS = 400;

/** Encode les `Uint8Array` en Base64 pour survivre au JSON. */
function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __bytes: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = encode(entry);
    }
    return out;
  }
  return value;
}

function decode(value: unknown): unknown {
  if (value && typeof value === 'object' && '__bytes' in (value as Record<string, unknown>)) {
    return new Uint8Array(Buffer.from((value as { __bytes: string }).__bytes, 'base64'));
  }
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = decode(entry);
    }
    return out;
  }
  return value;
}

export class LocalPersistence {
  private readonly file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(file = process.env.LOCAL_DATA_FILE ?? resolve(process.cwd(), '.local-data.json')) {
    this.file = file;
  }

  path(): string {
    return this.file;
  }

  /** Restaure l'instantané s'il existe ; renvoie `true` si des données ont été chargées. */
  restore(memory: MemoryDatabase, objects: Map<string, { body: Uint8Array; type: string }>): boolean {
    if (!existsSync(this.file)) return false;
    try {
      const snapshot = JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
      if (snapshot.version !== 1) return false;

      for (const [table, rows] of Object.entries(snapshot.tables ?? {})) {
        const key = memory.keyOf(table);
        if (!key || key.length === 0) continue;
        memory.importAll({ [table]: rows.map((row) => decode(row) as Record<string, unknown>) });
      }

      for (const [key, object] of Object.entries(snapshot.objects ?? {})) {
        objects.set(key, {
          body: new Uint8Array(Buffer.from(object.base64, 'base64')),
          type: object.type,
        });
      }

      // Mêmes secrets qu'au démarrage précédent : les sessions restent valides
      // et la clé d'administration ne change pas.
      if (snapshot.secrets?.jwt && snapshot.secrets.admin) {
        this.secrets = snapshot.secrets;
      }
      return true;
    } catch (error) {
      console.warn('Instantané local illisible, ignoré', error);
      return false;
    }
  }

  /** Programme une sauvegarde différée (regroupe les écritures rapprochées). */
  schedule(memory: MemoryDatabase, objects: Map<string, { body: Uint8Array; type: string }>): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.flush(memory, objects);
    }, FLUSH_DELAY_MS);
    this.timer.unref?.();
  }

  /** Secrets à persister (JWT et clé admin), pour ne pas invalider les sessions. */
  private secrets: { jwt: string; admin: string } | null = null;

  setSecrets(secrets: { jwt: string; admin: string }): void {
    this.secrets = secrets;
  }

  /** Secrets restaurés depuis le disque, s'ils existaient. */
  restoredSecrets(): { jwt: string; admin: string } | null {
    return this.secrets;
  }

  /** Écrit immédiatement (arrêt du processus). */
  flush(memory: MemoryDatabase, objects: Map<string, { body: Uint8Array; type: string }>): void {
    try {
      const snapshot: Snapshot = {
        version: 1,
        savedAt: new Date().toISOString(),
        tables: encode(memory.exportAll()) as Record<string, Array<Record<string, unknown>>>,
        objects: Object.fromEntries(
          [...objects.entries()].map(([key, object]) => [
            key,
            { base64: Buffer.from(object.body).toString('base64'), type: object.type },
          ]),
        ),
        ...(this.secrets ? { secrets: this.secrets } : {}),
      };

      mkdirSync(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(snapshot), 'utf8');
      // `rename` est atomique : un plantage en cours d'écriture ne détruit pas
      // l'instantané précédent.
      renameSync(temporary, this.file);
      this.dirty = false;
    } catch (error) {
      console.warn('Sauvegarde locale impossible', error);
    }
  }

  /** Supprime l'instantané (remise à zéro volontaire). */
  clear(): void {
    try {
      rmSync(this.file, { force: true });
      this.dirty = false;
    } catch {
      /* rien à faire */
    }
  }
}
