/**
 * Liens de téléchargement et réservation d'exemplaire (C1, C3, C5, C6).
 *
 * Deux mécanismes complémentaires :
 *  - une **garde en mémoire** (compteur de jetons local) qui évite d'envoyer à
 *    DynamoDB un pic de 500 claims simultanés que le service refuserait en
 *    throttling — elle **n'est jamais l'autorité** ;
 *  - une **transaction DynamoDB conditionnelle** (`remaining > 0` + création du
 *    ticket), seule source de vérité : c'est elle qui garantit « jamais N+1 ».
 *
 * Un exemplaire est consommé **au claim**, pas au téléchargement du fichier.
 */
import { config } from './config';
import { db } from './db';
import { gone, invalidInput, notFound, unavailable } from './errors';
import { jitter, sleep } from './ids';
import { randomToken } from './ids';
import { jobQueue } from './queue';
import { pdfKey, presignedUrl } from './s3';
import type { LinkRow, PdfCacheRow, TicketRow } from './types';

const TICKET_TTL_SECONDS = 7 * 24 * 3600;
const PDF_CACHE_TTL_SECONDS = 7 * 24 * 3600;
const CLAIM_RETRIES = 5;
const MAX_VISITOR_ID_LENGTH = 100;

export interface CreateLinkInput {
  docId: string;
  docTitle: string;
  maxDownloads: number;
  createdByEmail: string;
  createdByName: string;
}

export function validateMaxDownloads(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw invalidInput('maxDownloads', 'Entrez un nombre entier entre 1 et 100 000.');
  }
  return value;
}

export async function createLink(input: CreateLinkInput): Promise<LinkRow> {
  const link: LinkRow = {
    token: randomToken(16),
    docId: input.docId,
    docTitle: input.docTitle,
    createdByEmail: input.createdByEmail,
    createdByName: input.createdByName,
    maxDownloads: input.maxDownloads,
    remaining: input.maxDownloads,
    status: 'ACTIVE',
    notified: false,
    createdAt: new Date().toISOString(),
  };
  await db().put(config().linksTable, link as unknown as Record<string, unknown>, {
    condition: 'attribute_not_exists(token)',
  });
  return link;
}

export async function getLink(token: string): Promise<LinkRow> {
  const link = await db().get<LinkRow>(config().linksTable, { token });
  if (!link) throw notFound('Ce lien n\'existe pas ou n\'est plus valide.');
  return link;
}

export async function listLinks(docId: string): Promise<LinkRow[]> {
  const result = await db().query<LinkRow>(config().linksTable, {
    index: 'docId-index',
    keyCondition: 'docId = :docId',
    values: { ':docId': docId },
  });
  return result.items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Garde en mémoire : plafond de claims simultanés par lien.
 *
 * Elle protège DynamoDB du pic sans jamais décider du quota : un claim refusé
 * par la garde reçoit `waiting` (le visiteur patiente), jamais `exhausted`.
 */
class ClaimGate {
  private readonly inFlight = new Map<string, number>();

  tryAcquire(token: string): boolean {
    const current = this.inFlight.get(token) ?? 0;
    if (current >= config().maxClaimsInFlight) return false;
    this.inFlight.set(token, current + 1);
    return true;
  }

  release(token: string): void {
    const current = this.inFlight.get(token) ?? 0;
    if (current <= 1) this.inFlight.delete(token);
    else this.inFlight.set(token, current - 1);
  }
}

const gate = new ClaimGate();

export interface VisitorStatus {
  status: 'active' | 'exhausted';
  title: string;
  remaining: number;
}

export async function linkStatus(token: string): Promise<VisitorStatus> {
  const link = await getLink(token);
  // `remaining` fait foi : le statut stocké peut être en retard d'un instant.
  const exhausted = link.status === 'EXHAUSTED' || link.remaining <= 0;
  return {
    status: exhausted ? 'exhausted' : 'active',
    title: link.docTitle,
    remaining: Math.max(0, link.remaining),
  };
}

export interface ClaimResult {
  status: number;
  body:
    | { state: 'ready'; url: string; expiresIn: number }
    | { state: 'waiting'; retryAfter: number }
    | { state: 'exhausted' };
}

export function validateVisitorId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length < 8 || value.length > MAX_VISITOR_ID_LENGTH) {
    throw invalidInput('visitorId', 'Identifiant de visiteur invalide.');
  }
  return value;
}

/**
 * Réserve un exemplaire.
 *
 * Ordre **imposé** par la spécification (4.2) : on cherche le ticket **avant**
 * le court-circuit `exhausted`. Sans cela, un visiteur qui possède déjà son
 * exemplaire recevrait `410` après l'épuisement du lien.
 */
export async function claim(token: string, visitorId: string): Promise<ClaimResult> {
  const cfg = config();
  const link = await getLink(token);

  // 1. Le visiteur a-t-il déjà un ticket ? (avanti tout court-circuit)
  const existing = await db().get<TicketRow>(cfg.ticketsTable, { token, visitorId });
  if (existing) return resolve(existing, link.docTitle);

  // 2. Lien déjà épuisé : plus aucun travail (C6).
  if (link.status === 'EXHAUSTED' || link.remaining <= 0) {
    const late = await db().get<TicketRow>(cfg.ticketsTable, { token, visitorId });
    if (late) return resolve(late, link.docTitle);
    return { status: 410, body: { state: 'exhausted' } };
  }

  // 3. Garde mémoire : on ne noie pas DynamoDB sous le pic.
  if (!gate.tryAcquire(token)) {
    return { status: 202, body: { state: 'waiting', retryAfter: 1 } };
  }

  try {
    for (let attempt = 0; attempt < CLAIM_RETRIES; attempt++) {
      const current = attempt === 0 ? link : await getLink(token);
      if (current.status === 'EXHAUSTED' || current.remaining <= 0) {
        const late = await db().get<TicketRow>(cfg.ticketsTable, { token, visitorId });
        if (late) return resolve(late, current.docTitle);
        return { status: 410, body: { state: 'exhausted' } };
      }

      // T1 : la version est figée **ici**, en lisant le dernier `seq` écrit.
      const seqFrozen = await lastWrittenSeq(current.docId);
      const ticket: TicketRow = {
        token,
        visitorId,
        docId: current.docId,
        seqFrozen,
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS,
      };

      const outcome = await db().transact([
        {
          Update: {
            table: cfg.linksTable,
            key: { token },
            update: 'ADD remaining :minusOne',
            condition: 'remaining > :zero AND #status = :active',
            names: { '#status': 'status' },
            values: { ':minusOne': -1, ':zero': 0, ':active': 'ACTIVE' },
          },
        },
        {
          Put: {
            table: cfg.ticketsTable,
            item: ticket as unknown as Record<string, unknown>,
            condition: 'attribute_not_exists(visitorId)',
          },
        },
      ]);

      if (outcome.ok) {
        // Transition monotone ACTIVE → EXHAUSTED, séparée et idempotente :
        // seul le claim qui amène réellement `remaining` à 0 peut la poser.
        await db()
          .update(
            cfg.linksTable,
            { token },
            {
              update: 'SET #status = :exhausted, exhaustedAt = :now',
              condition: '#status = :active AND remaining = :zero',
              names: { '#status': 'status' },
              values: { ':exhausted': 'EXHAUSTED', ':active': 'ACTIVE', ':zero': 0, ':now': new Date().toISOString() },
            },
          )
          .catch(() => undefined);

        return resolve(ticket, current.docTitle);
      }

      // Ticket créé par une requête concurrente du même visiteur ?
      const retry = await db().get<TicketRow>(cfg.ticketsTable, { token, visitorId });
      if (retry) return resolve(retry, current.docTitle);

      const linkReason = outcome.reasons?.[0]?.code;
      if (linkReason === 'ConditionalCheckFailed') {
        const fresh = await getLink(token);
        if (fresh.status === 'EXHAUSTED' || fresh.remaining <= 0) {
          return { status: 410, body: { state: 'exhausted' } };
        }
      }

      await sleep(20 * 2 ** attempt + jitter(30));
    }

    // Contention extrême : le visiteur n'est jamais jeté, il patiente.
    return { status: 202, body: { state: 'waiting', retryAfter: 1 } };
  } finally {
    gate.release(token);
  }
}

/** Reprise de polling : `GET /d/{token}/file?visitorId=…`. */
export async function file(token: string, visitorId: string): Promise<ClaimResult> {
  const cfg = config();
  const ticket = await db().get<TicketRow>(cfg.ticketsTable, { token, visitorId });
  if (!ticket) throw gone('NO_TICKET', 'Aucun exemplaire réservé pour ce visiteur.');
  const link = await db().get<LinkRow>(cfg.linksTable, { token });
  return resolve(ticket, link?.docTitle ?? 'document');
}

/** Résout le PDF d'un ticket : prêt, en génération, ou à générer. */
export async function resolve(ticket: TicketRow, docTitle: string): Promise<ClaimResult> {
  const cfg = config();
  const cacheId = `${ticket.docId}#${ticket.seqFrozen}`;
  const cache = await db().get<PdfCacheRow>(cfg.pdfCacheTable, { id: cacheId });

  if (cache?.status === 'READY' && cache.s3Key) {
    const url = await presignedUrl(cache.s3Key, `${slug(docTitle)}.pdf`, cfg.pdfUrlTtlSeconds);
    return { status: 200, body: { state: 'ready', url, expiresIn: cfg.pdfUrlTtlSeconds } };
  }

  if (cache?.status === 'BUILDING') {
    return { status: 202, body: { state: 'waiting', retryAfter: 2 } };
  }

  // Absent ou en échec : un seul claimant arme le verrou et publie le job.
  const attempts = Number(cache?.attempts ?? 0);
  if (cache?.status === 'FAILED' && attempts >= 3) {
    // Trois échecs : on ne fait plus attendre le visiteur indéfiniment.
    throw unavailable('PDF_UNAVAILABLE', 'La génération du document a échoué. Réessayez dans quelques instants.');
  }

  const leaseUntil = Date.now() + 120_000;
  try {
    if (cache) {
      await db().update(
        cfg.pdfCacheTable,
        { id: cacheId },
        {
          update: 'SET #status = :building, attempts = :next, leaseUntil = :lease',
          condition: '#status = :failed OR leaseUntil < :nowAbsent OR attribute_not_exists(leaseUntil)',
          names: { '#status': 'status' },
          values: {
            ':building': 'BUILDING',
            ':failed': 'FAILED',
            ':next': attempts + 1,
            ':lease': leaseUntil,
            ':nowAbsent': 0,
          },
        },
      );
    } else {
      await db().put(
        cfg.pdfCacheTable,
        {
          id: cacheId,
          docId: ticket.docId,
          seq: ticket.seqFrozen,
          status: 'BUILDING',
          attempts: 0,
          leaseUntil,
          createdAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + PDF_CACHE_TTL_SECONDS,
        },
        { condition: 'attribute_not_exists(id)' },
      );
    }
    await jobQueue().enqueue({ docId: ticket.docId, seq: ticket.seqFrozen, cacheId });
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
  }

  return { status: 202, body: { state: 'waiting', retryAfter: 2 } };
}

/**
 * Dernier `seq` réellement écrit.
 *
 * Le hub temps réel garde cette valeur en mémoire ; sans hub (redémarrage,
 * autre processus), on retombe sur la table `Documents`.
 */
let lastSeqReader: ((docId: string) => Promise<number>) | null = null;

export function setLastSeqReader(reader: ((docId: string) => Promise<number>) | null): void {
  lastSeqReader = reader;
}

async function lastWrittenSeq(docId: string): Promise<number> {
  if (lastSeqReader) return lastSeqReader(docId);
  const doc = await db().get<{ seq: number }>(config().documentsTable, { docId });
  return doc?.seq ?? 0;
}

export function slug(title: string): string {
  const clean = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
  return clean || 'document';
}

export { pdfKey };
