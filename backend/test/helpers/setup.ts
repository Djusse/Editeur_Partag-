/**
 * Amorçage commun aux tests : double en mémoire, stockage objet simulé,
 * secrets éphémères, `seq` lu en mémoire.
 */
import { MemoryDatabase } from './memory-db';
import { setDatabase } from '../../src/lib/db';
import { setObjectStore, type ObjectStore } from '../../src/lib/s3';
import { setSecretOverrides } from '../../src/lib/secrets';
import { setJobQueue } from '../../src/lib/queue';
import { setLastSeqReader } from '../../src/lib/links';
import { resetConfigCache } from '../../src/lib/config';
import { manager } from '../../src/realtime/manager';
import type { PdfJob } from '../../src/lib/pdf';

export const TABLES: Array<[string, string[]]> = [
  ['Documents', ['docId']],
  ['Members', ['docId', 'email']],
  ['Updates', ['docId', 'seq']],
  ['Credits', ['id']],
  ['OpIds', ['id']],
  ['Abuse', ['id']],
  ['Links', ['token']],
  ['Tickets', ['token', 'visitorId']],
  ['PdfCache', ['id']],
  ['Versions', ['docId', 'n']],
];

export class MemoryStore implements ObjectStore {
  private readonly objects = new Map<string, { body: Uint8Array; type: string }>();

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: new Uint8Array(body), type: contentType });
  }

  async get(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`Objet absent : ${key}`);
    return object.body;
  }

  async presign(key: string, filename: string, ttl: number): Promise<string> {
    return `memory://${key}?filename=${encodeURIComponent(filename)}&ttl=${ttl}`;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}

export interface Harness {
  memory: MemoryDatabase;
  store: MemoryStore;
  jobs: PdfJob[];
}

/** Prépare un environnement isolé ; à appeler dans `beforeEach`. */
export function setupHarness(options: { creditPerDay?: number; blockAfterRefusals?: number } = {}): Harness {
  manager.stop();
  resetConfigCache();

  process.env.APP_MODE = 'local';
  process.env.AWS_REGION = 'eu-north-1';
  process.env.DOCUMENTS_TABLE = 'Documents';
  process.env.MEMBERS_TABLE = 'Members';
  process.env.UPDATES_TABLE = 'Updates';
  process.env.CREDITS_TABLE = 'Credits';
  process.env.OPIDS_TABLE = 'OpIds';
  process.env.ABUSE_TABLE = 'Abuse';
  process.env.LINKS_TABLE = 'Links';
  process.env.TICKETS_TABLE = 'Tickets';
  process.env.PDFCACHE_TABLE = 'PdfCache';
  process.env.VERSIONS_TABLE = 'Versions';
  process.env.BUCKET = 'test-bucket';
  process.env.SES_SENDER = 'test@exemple.cm';
  process.env.JWT_SECRET_PARAM = '/test/jwt';
  process.env.ADMIN_KEY_PARAM = '/test/admin';
  process.env.CREDIT_PER_DAY = String(options.creditPerDay ?? 10000);
  process.env.BLOCK_AFTER_REFUSALS = String(options.blockAfterRefusals ?? 4);
  process.env.TICK_MS = '10';
  process.env.SNAPSHOT_EVERY_ENTRIES = '50';
  resetConfigCache();

  const memory = new MemoryDatabase(TABLES);
  const store = new MemoryStore();
  const jobs: PdfJob[] = [];

  setDatabase(memory);
  setObjectStore(store);
  setSecretOverrides({ jwt: 'secret-de-test', admin: 'cle-admin-de-test' });
  setJobQueue({
    async enqueue(job) {
      jobs.push(job);
    },
  });
  setLastSeqReader(async (docId) => {
    const doc = await memory.get<{ seq: number }>('Documents', { docId });
    return doc?.seq ?? 0;
  });

  return { memory, store, jobs };
}

export function teardownHarness(): void {
  manager.stop();
  setDatabase(null);
  setObjectStore(null);
  setSecretOverrides(null);
  setJobQueue(null);
  setLastSeqReader(null);
}

/** Crée un document prêt à l'emploi (avec son propriétaire). */
export async function seedDocument(
  memory: MemoryDatabase,
  input: { docId?: string; title?: string; ownerEmail?: string } = {},
): Promise<{ docId: string; ownerEmail: string }> {
  const docId = input.docId ?? 'doc_test';
  const ownerEmail = input.ownerEmail ?? 'owner@exemple.cm';
  const now = new Date().toISOString();

  await memory.put('Documents', {
    docId,
    title: input.title ?? 'Journal 2026',
    ownerEmail,
    ownerName: 'Propriétaire',
    seq: 0,
    latestSnapshotSeq: 0,
    textLength: 0,
    createdAt: now,
    updatedAt: now,
  });
  await memory.put('Members', {
    docId,
    email: ownerEmail,
    name: 'Propriétaire',
    role: 'owner',
    addedAt: now,
  });

  return { docId, ownerEmail };
}

export async function addMemberTo(memory: MemoryDatabase, docId: string, email: string): Promise<void> {
  await memory.put('Members', {
    docId,
    email,
    name: email.split('@')[0],
    role: 'editor',
    addedAt: new Date().toISOString(),
  });
}
