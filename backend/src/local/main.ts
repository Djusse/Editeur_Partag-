/**
 * Mode local — aucun compte AWS.
 *
 * Le serveur exécute **le même code** qu'en production (Fastify, hub, claim,
 * crédit, PDF) ; seules les dépendances externes sont remplacées :
 *
 *   DynamoDB → double en mémoire      S3 → stockage mémoire + route de fichiers
 *   SQS      → exécution immédiate    SSM → secrets éphémères
 *
 * Ce qui est donc réellement vérifiable : C1 (quota exact), C2 (deux onglets
 * convergent), C3 (PDF à la version figée), C4 (crédit et blocage), versions,
 * présence et WebSocket natif — ce dernier point est une différence importante
 * avec une architecture Lambda, où le WebSocket n'aurait pas pu être testé en
 * local. Ce qui n'est pas vérifiable : le pic de charge (C5) et SES.
 */
import { MemoryDatabase } from '../../test/helpers/memory-db';
import { setDatabase } from '../lib/db';
import { setObjectStore, type ObjectStore } from '../lib/s3';
import { setSecretOverrides, generateLocalSecrets } from '../lib/secrets';
import { setJobQueue } from '../lib/queue';
import { setLastSeqReader } from '../lib/links';
import { resetConfigCache } from '../lib/config';
import { buildPdf, type PdfJob } from '../lib/pdf';
import { manager } from '../realtime/manager';
import { LocalPersistence } from './persistence';

const TABLES: Array<[string, string[]]> = [
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

class LocalStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; type: string }>();
  /** Appelé après chaque écriture, pour la sauvegarde sur disque. */
  onChange: (() => void) | null = null;

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: new Uint8Array(body), type: contentType });
    this.onChange?.();
  }

  async get(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`Objet absent : ${key}`);
    return object.body;
  }

  async presign(key: string, filename: string, ttl: number): Promise<string> {
    return `/files/${key}?filename=${encodeURIComponent(filename)}&ttl=${ttl}`;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  contentType(key: string): string {
    return this.objects.get(key)?.type ?? 'application/octet-stream';
  }
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 4000);

  Object.assign(process.env, {
    APP_MODE: 'local',
    PORT: String(port),
    HOST: '127.0.0.1',
    STATIC_DIR: './public-absent',
    AWS_REGION: 'eu-north-1',
    DOCUMENTS_TABLE: 'Documents',
    MEMBERS_TABLE: 'Members',
    UPDATES_TABLE: 'Updates',
    CREDITS_TABLE: 'Credits',
    OPIDS_TABLE: 'OpIds',
    ABUSE_TABLE: 'Abuse',
    LINKS_TABLE: 'Links',
    TICKETS_TABLE: 'Tickets',
    PDFCACHE_TABLE: 'PdfCache',
    VERSIONS_TABLE: 'Versions',
    BUCKET: 'local',
    SES_SENDER: 'local@exemple.test',
    // Le suffixe `admin-key` est significatif : `readParameter` s'en sert pour
    // distinguer les deux secrets. Le changer ferait servir le JWT comme clé
    // d'administration (donc un refus systématique sur /admin).
    JWT_SECRET_PARAM: '/local/jwt-secret',
    ADMIN_KEY_PARAM: '/local/admin-key',
    // En développement, le front (3000) et l'API (4000) sont deux origines :
    // le navigateur exige donc un préflight CORS autorisant cette origine.
    WEB_ORIGIN: 'http://localhost:3000',
  });

  resetConfigCache();

  const memory = new MemoryDatabase(TABLES);
  const store = new LocalStore();

  // --- Persistance sur disque ---------------------------------------------
  // Sans elle, chaque redémarrage effaçait liens, documents **et sessions** :
  // un lien copié devenait « inconnu » et l'on croyait à une expiration.
  // La durabilité en production est assurée par DynamoDB et S3 ; ici, un
  // fichier JSON suffit.
  const persistence = new LocalPersistence();
  const restored = persistence.restore(memory, store.objects);
  store.onChange = () => persistence.schedule(memory, store.objects);

  // Les secrets sont réutilisés s'ils existent : sinon chaque redémarrage
  // invalidait toutes les sessions et changeait la clé d'administration.
  const secrets = persistence.restoredSecrets() ?? generateLocalSecrets();
  persistence.setSecrets(secrets);

  if (restored) {
    console.log(`Données locales restaurées depuis ${persistence.path()}`);
  }

  setDatabase(memory);
  setObjectStore(store);
  setSecretOverrides(secrets);
  // Chaque écriture (update, crédit, lien, ticket…) déclenche une sauvegarde
  // différée : on ne réécrit pas le fichier à chaque frappe.
  const scheduleSave = () => persistence.schedule(memory, store.objects);
  for (const method of ['put', 'update', 'delete', 'transact'] as const) {
    const original = (memory[method] as (...args: unknown[]) => Promise<unknown>).bind(memory);
    (memory as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      const result = await original(...args);
      scheduleSave();
      return result;
    };
  }
  // La file devient une exécution immédiate : le visiteur voit bien
  // `waiting` puis `ready`, exactement comme avec SQS.
  setJobQueue({
    async enqueue(job: PdfJob) {
      setImmediate(() => {
        void buildPdf(job).catch((error) => console.error('PDF local en échec', error));
      });
    },
  });
  setLastSeqReader((docId) => manager.lastSeq(docId));


  const { buildApp } = await import('../server/app');
  const { attachProtocol } = await import('../realtime/protocol');
  const { startTicketSweeper } = await import('../realtime/tickets');
  const { WebSocketServer } = await import('ws');

  const app = buildApp({ logger: false });

  // Sert les fichiers « S3 » (PDF et snapshots) pour que le téléchargement
  // fonctionne réellement depuis le navigateur.
  app.get('/files/*', async (request, reply) => {
    const key = decodeURIComponent((request.params as { '*': string })['*']);
    if (!store.has(key)) {
      reply.code(404);
      return { error: 'NOT_FOUND' };
    }
    const body = await store.get(key);
    reply.header('content-type', store.contentType(key));
    reply.header('content-disposition', 'inline');
    return reply.send(Buffer.from(body));
  });

  // Diagnostic : état des tables et clé admin.
  app.get('/__debug', async () => ({
    adminKey: secrets.admin,
    tables: Object.fromEntries(TABLES.map(([name]) => [name, memory.count(name)])),
    documentsInMemory: manager.openDocuments(),
  }));

  await app.listen({ port, host: '127.0.0.1' });

  const wss = new WebSocketServer({ server: app.server, path: '/ws', maxPayload: 2 * 1024 * 1024 });
  attachProtocol(wss);
  startTicketSweeper();

  // Sauvegarde immédiate à l'arrêt : les dernières frappes ne sont pas perdues.
  const shutdown = () => {
    persistence.flush(memory, store.objects);
    console.log(`Données sauvegardées dans ${persistence.path()}`);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`
┌───────────────────────────────────────────────────────────────────────┐
│  Mode local — aucun appel AWS                                         │
├───────────────────────────────────────────────────────────────────────┤
│  API         : http://localhost:${port}
│  Diagnostic  : http://localhost:${port}/__debug
│  Clé admin   : ${secrets.admin}
│  Données     : ${persistence.path()}
│                                                                       │
│  REST + WebSocket natif + PDF réel + crédit + quota : tout fonctionne │
│  Non simulé  : pic de charge (C5), SES, CloudFront/nginx              │
│                                                                       │
│  Les liens et documents survivent au redémarrage.                     │
│  Remise à zéro : supprimer le fichier de données ci-dessus.           │
└───────────────────────────────────────────────────────────────────────┘
`);
}

main().catch((error) => {
  console.error('Démarrage impossible', error);
  process.exit(1);
});
