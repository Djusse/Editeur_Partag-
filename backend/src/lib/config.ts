/**
 * Configuration de l'application, lue depuis les variables d'environnement
 * injectées par le template SAM. Aucune valeur secrète n'est stockée ici :
 * les secrets (JWT, clé admin) sont lus dans SSM Parameter Store.
 */
export interface AppConfig {
  region: string;
  documentsTable: string;
  updatesTable: string;
  membersTable: string;
  connectionsTable: string;
  creditsTable: string;
  opIdsTable: string;
  abuseTable: string;
  linksTable: string;
  ticketsTable: string;
  wsTicketsTable: string;
  pdfCacheTable: string;
  versionsTable: string;
  pdfBucket: string;
  wsEndpoint: string;
  jwtSecretParam: string;
  adminKeyParam: string;
  sesSender: string;
  webOrigin: string;
  pdfFunctionName: string;
  snapshotFunctionName: string;
  creditPerDay: number;
  maxUpdateBytes: number;
  blockAfterRefusals: number;
  pdfUrlTtlSeconds: number;
  snapshotInterval: number;
  sessionTtlSeconds: number;
  ticketTtlSeconds: number;
}

let cached: AppConfig | null = null;

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Configuration manquante : variable d'environnement ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function numberVar(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function config(): AppConfig {
  if (cached) return cached;
  cached = {
    region: optional('AWS_REGION', 'eu-west-3'),
    documentsTable: need('DOCUMENTS_TABLE'),
    updatesTable: need('UPDATES_TABLE'),
    membersTable: need('MEMBERS_TABLE'),
    connectionsTable: need('CONNECTIONS_TABLE'),
    creditsTable: need('CREDITS_TABLE'),
    opIdsTable: need('OPIDS_TABLE'),
    abuseTable: need('ABUSE_TABLE'),
    linksTable: need('LINKS_TABLE'),
    ticketsTable: need('TICKETS_TABLE'),
    wsTicketsTable: need('WSTICKETS_TABLE'),
    pdfCacheTable: need('PDFCACHE_TABLE'),
    versionsTable: need('VERSIONS_TABLE'),
    pdfBucket: need('PDF_BUCKET'),
    wsEndpoint: optional('WS_ENDPOINT', ''),
    jwtSecretParam: need('JWT_SECRET_PARAM'),
    adminKeyParam: need('ADMIN_KEY_PARAM'),
    sesSender: need('SES_SENDER'),
    webOrigin: optional('WEB_ORIGIN', '*'),
    pdfFunctionName: optional('PDF_FUNCTION_NAME', ''),
    snapshotFunctionName: optional('SNAPSHOT_FUNCTION_NAME', ''),
    creditPerDay: numberVar('CREDIT_PER_DAY', 10000),
    maxUpdateBytes: numberVar('MAX_UPDATE_BYTES', 16 * 1024),
    blockAfterRefusals: numberVar('BLOCK_AFTER_REFUSALS', 4),
    pdfUrlTtlSeconds: numberVar('PDF_URL_TTL_SECONDS', 60),
    snapshotInterval: numberVar('SNAPSHOT_INTERVAL', 50),
    sessionTtlSeconds: numberVar('SESSION_TTL_SECONDS', 7 * 24 * 3600),
    ticketTtlSeconds: numberVar('TICKET_TTL_SECONDS', 60),
  };
  return cached;
}

/** Réservé aux tests : force la relecture des variables d'environnement. */
export function resetConfigCache(): void {
  cached = null;
}
