/**
 * Stockage objet en mémoire pour le mode local (aucun appel S3).
 * Les URL « présignées » renvoient vers une route du serveur local.
 */
import type { ObjectStore } from '../lib/s3';

export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: new Uint8Array(body), contentType });
  }

  async get(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`Objet absent du stockage local : ${key}`);
    return object.body;
  }

  contentType(key: string): string {
    return this.objects.get(key)?.contentType ?? 'application/octet-stream';
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  size(): number {
    return this.objects.size;
  }
}
