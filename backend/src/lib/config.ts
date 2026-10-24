/**
 * Configuration du serveur applicatif.
 *
 * Deux modes :
 *  - **production** : EC2, les secrets sont lus dans SSM Parameter Store ;
 *  - **local** : aucune ressource AWS, tout est en mémoire (voir `src/local`).
 *
 * Aucune valeur secrète n'est ici : uniquement des noms de paramètres et des
 * réglages fonctionnels.
 */
export interface AppConfig {
  /** Mode d'exécution. `local` n'appelle jamais AWS. */
  mode: 'production' | 'local';
  region: string;
  port: number;
  host: string;

  /** Tables DynamoDB. */
  documentsTable: string;
  membersTable: string;
  updatesTable: string;
  creditsTable: string;
  opIdsTable: string;
  abuseTable: string;
  linksTable: string;
  ticketsTable: string;
  pdfCacheTable: string;
  versionsTable: string;

  /** Stockage objet (PDF et snapshots). */
  bucket: string;

  /** SQS : génération PDF. */
  pdfQueueUrl: string;

  /** SES et supervision. */
  sesSender: string;
  jwtSecretParam: string;
  adminKeyParam: string;

  /** Réglages métier. */
  creditPerDay: number;
  /** Plafond d'un update binaire (64 Ko, exigence de l'interface). */
  maxUpdateBytes: number;
  /** Nombre de refus pour crédit épuisé avant blocage. */
  blockAfterRefusals: number;
  /** Durée de validité d'une URL S3 présignée. */
  pdfUrlTtlSeconds: number;
  /** Regroupement des frappes côté client. */
  batchMs: number;
  /** Période du tick d'écriture serveur. */
  tickMs: number;
  /** Snapshot automatique toutes les N entrées de journal. */
  snapshotEveryEntries: number;
  /** Snapshot automatique toutes les N millisecondes d'activité. */
  snapshotEveryMs: number;
  /** Durée de vie d'un ticket WebSocket. */
  wsTicketTtlSeconds: number;
  /** Durée de vie d'une session JWT. */
  sessionTtlSeconds: number;
  /** Limite de transactions de claim en vol (garde en mémoire). */
  maxClaimsInFlight: number;
  /** Délai d'inactivité avant de décharger un document de la mémoire. */
  idleDocMs: number;
  /** Dossier du front statique. */
  staticDir: string;
}

let cached: AppConfig | null = null;

function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function config(): AppConfig {
  if (cached) return cached;
  cached = {
    mode: str('APP_MODE', 'production') === 'local' ? 'local' : 'production',
    region: str('AWS_REGION', 'eu-north-1'),
    port: int('PORT', 3000),
    host: str('HOST', '0.0.0.0'),

    documentsTable: str('DOCUMENTS_TABLE', 'Documents'),
    membersTable: str('MEMBERS_TABLE', 'Members'),
    updatesTable: str('UPDATES_TABLE', 'Updates'),
    creditsTable: str('CREDITS_TABLE', 'Credits'),
    opIdsTable: str('OPIDS_TABLE', 'OpIds'),
    abuseTable: str('ABUSE_TABLE', 'Abuse'),
    linksTable: str('LINKS_TABLE', 'Links'),
    ticketsTable: str('TICKETS_TABLE', 'Tickets'),
    pdfCacheTable: str('PDFCACHE_TABLE', 'PdfCache'),
    versionsTable: str('VERSIONS_TABLE', 'Versions'),

    bucket: str('BUCKET', 'editeur-pdf'),
    pdfQueueUrl: str('PDF_QUEUE_URL', ''),
    sesSender: str('SES_SENDER', ''),
    jwtSecretParam: str('JWT_SECRET_PARAM', '/editeur/jwt-secret'),
    adminKeyParam: str('ADMIN_KEY_PARAM', '/editeur/admin-key'),

    creditPerDay: int('CREDIT_PER_DAY', 10000),
    maxUpdateBytes: int('MAX_UPDATE_BYTES', 64 * 1024),
    blockAfterRefusals: int('BLOCK_AFTER_REFUSALS', 4),
    pdfUrlTtlSeconds: int('PDF_URL_TTL_SECONDS', 60),
    batchMs: int('BATCH_MS', 300),
    tickMs: int('TICK_MS', 250),
    snapshotEveryEntries: int('SNAPSHOT_EVERY_ENTRIES', 50),
    snapshotEveryMs: int('SNAPSHOT_EVERY_MS', 120_000),
    wsTicketTtlSeconds: int('WS_TICKET_TTL_SECONDS', 60),
    sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 3600),
    maxClaimsInFlight: int('MAX_CLAIMS_IN_FLIGHT', 50),
    idleDocMs: int('IDLE_DOC_MS', 30 * 60_000),
    staticDir: str('STATIC_DIR', './public'),
  };
  return cached;
}

/** Réservé aux tests : force la relecture des variables d'environnement. */
export function resetConfigCache(): void {
  cached = null;
}

/** Réglages exposés au front par `GET /config` (aucun secret). */
export function publicConfig() {
  const cfg = config();
  return {
    batchMs: cfg.batchMs,
    creditPerDay: cfg.creditPerDay,
    maxUpdateBytes: cfg.maxUpdateBytes,
    wsTicketTtlSeconds: cfg.wsTicketTtlSeconds,
  };
}
