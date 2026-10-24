/**
 * Liens de téléchargement et réservation d'exemplaire (C1, C3, C5, C6).
 *
 * Principe : un exemplaire est consommé **au claim**, pas au téléchargement.
 * Le décrément de `remaining` et la création du ticket sont dans une **seule**
 * transaction conditionnelle : jamais N+1, même sous forte concurrence.
 */
import { config } from './config';
import { getItem, putItem, query, transactWrite, updateItem } from './db';
import { ApiError, badRequest, gone, notFound } from './errors';
import { clampText, jitter, randomToken, utcDay } from './ids';
import { getDocument } from './documents';
import { presignedUrl, pdfKey } from './s3';
import type { LinkRow, PdfCacheRow, TicketRow } from './types';

const MAX_RETRIES = 6;
const PDF_TTL_SECONDS = 7 * 24 * 3600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createLink(input: {
  docId: string;
  maxDownloads: number;
  createdByEmail: string;
  createdByName: string;
}): Promise<LinkRow> {
  const maxDownloads = Math.floor(Number(input.maxDownloads));
  if (!Number.isFinite(maxDownloads) || maxDownloads < 1 || maxDownloads > 100000) {
    throw badRequest('INVALID_MAX_DOWNLOADS', 'Le nombre de téléchargements doit être compris entre 1 et 100000');
  }
  const doc = await getDocument(input.docId);
  const link: LinkRow = {
    token: randomToken(16),
    docId: doc.docId,
    docTitle: doc.title,
    createdByEmail: input.createdByEmail,
    createdByName: input.createdByName,
    maxDownloads,
    remaining: maxDownloads,
    status: 'ACTIVE',
    notified: false,
    createdAt: new Date().toISOString(),
  };
  await putItem(config().linksTable, link as unknown as Record<string, unknown>, {
    condition: 'attribute_not_exists(token)',
  });
  return link;
}

export async function getLink(token: string): Promise<LinkRow> {
  const link = await getItem<LinkRow>(config().linksTable, { token });
  if (!link) throw notFound('LINK_NOT_FOUND', 'Lien inconnu ou supprimé');
  return link;
}

export async function listLinksForDocument(docId: string): Promise<LinkRow[]> {
  const result = await query<LinkRow>({
    table: config().linksTable,
    index: 'docId-index',
    keyCondition: 'docId = :docId',
    values: { ':docId': docId },
  });
  return result.items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export interface VisitorStatus {
  status: 'active' | 'exhausted';
  remaining: number;
  maxDownloads: number;
  docTitle: string;
  updatedAt: string;
}

export async function linkStatus(token: string): Promise<VisitorStatus> {
  const link = await getLink(token);
  // `remaining` fait foi : si le compteur est à 0, le lien est épuisé même si
  // la transition de statut n'a pas encore été écrite (C6, sans faux positif).
  const exhausted = link.status === 'EXHAUSTED' || link.remaining <= 0;
  return {
    status: exhausted ? 'exhausted' : 'active',
    remaining: Math.max(0, link.remaining),
    maxDownloads: link.maxDownloads,
    docTitle: link.docTitle,
    updatedAt: new Date().toISOString(),
  };
}

export interface ClaimResult {
  state: 'ready' | 'waiting' | 'exhausted';
  ticket?: TicketRow;
  seqFrozen?: number;
  url?: string;
  retryAfter?: number;
  remaining: number;
  status: number;
}

/**
 * Fixe la version du document au moment du claim : c'est la définition de T1.
 * Le PDF sera construit à partir de ce `seq` figé, jamais du texte courant au
 * moment où la Lambda de génération s'exécute.
 */
export async function claimDownload(token: string, visitorId: string): Promise<ClaimResult> {
  if (!visitorId || visitorId.length < 8 || visitorId.length > 100) {
    throw badRequest('INVALID_VISITOR_ID', 'Identifiant de visiteur invalide');
  }
  const cfg = config();
  const link = await getLink(token);

  // Court-circuit EXHAUSTED : aucun calcul, réponse immédiatement cachable (C6).
  if (link.status === 'EXHAUSTED') {
    const existing = await getItem<TicketRow>(cfg.ticketsTable, { token, visitorId });
    if (existing) return resolvePdf(existing, link);
    return { state: 'exhausted', remaining: 0, status: 410 };
  }

  // Idempotence : un retry renvoie le même ticket, sans consommer d'exemplaire.
  const existing = await getItem<TicketRow>(cfg.ticketsTable, { token, visitorId });
  if (existing) return resolvePdf(existing, link);

  let lastReason: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = attempt === 0 ? link : await getLink(token);
    if (current.status === 'EXHAUSTED') {
      const retryTicket = await getItem<TicketRow>(cfg.ticketsTable, { token, visitorId });
      if (retryTicket) return resolvePdf(retryTicket, current);
      return { state: 'exhausted', remaining: 0, status: 410 };
    }

    // T1 : lecture de `seq` au début du claim.
    const doc = await getDocument(current.docId);
    const ticket: TicketRow = {
      token,
      visitorId,
      docId: current.docId,
      seqFrozen: doc.seq,
      createdAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + PDF_TTL_SECONDS,
    };

    const outcome = await transactWrite([
      {
        update: {
          table: cfg.linksTable,
          key: { token },
          // Le statut n'est **pas** modifié ici : il dépend du `remaining`
          // résultant, qui n'est connu de façon fiable qu'après le décrément.
          update: 'ADD remaining :minusOne',
          condition: 'remaining > :zero AND #status = :active',
          names: { '#status': 'status' },
          values: { ':minusOne': -1, ':zero': 0, ':active': 'ACTIVE' },
        },
      },
      {
        put: {
          table: cfg.ticketsTable,
          item: ticket as unknown as Record<string, unknown>,
          condition: 'attribute_not_exists(visitorId)',
        },
      },
    ]);

    if (outcome.ok) {
      // Transition monotone ACTIVE → EXHAUSTED, atomique et idempotente :
      // seul le claim qui amène réellement `remaining` à 0 peut la poser.
      await updateItem(
        cfg.linksTable,
        { token },
        {
          update: 'SET #status = :exhausted, exhaustedAt = :now',
          condition: '#status = :active AND remaining = :zero',
          names: { '#status': 'status' },
          values: { ':exhausted': 'EXHAUSTED', ':active': 'ACTIVE', ':zero': 0, ':now': new Date().toISOString() },
        },
      ).catch(() => undefined);
      return resolvePdf(ticket, current);
    }

    const ticketReason = outcome.reasons?.[1]?.code;
    if (ticketReason === 'ConditionalCheckFailed') {
      const retryTicket = await getItem<TicketRow>(cfg.ticketsTable, { token, visitorId });
      if (retryTicket) return resolvePdf(retryTicket, await getLink(token));
    }
    const linkReason = outcome.reasons?.[0]?.code;
    if (linkReason === 'ConditionalCheckFailed') {
      const retryTicket = await getItem<TicketRow>(cfg.ticketsTable, { token, visitorId });
      if (retryTicket) return resolvePdf(retryTicket, await getLink(token));
      const fresh = await getLink(token);
      if (fresh.status === 'EXHAUSTED' || fresh.remaining <= 0) {
        return { state: 'exhausted', remaining: 0, status: 410 };
      }
    }
    lastReason = outcome.reasons;
    await sleep(Math.min(300, 15 * 2 ** attempt) + jitter(40));
  }

  // Contention extrême : le visiteur n'est pas "jeté" (sujet), il patiente.
  console.warn('Contention sur le claim', { token, attempts: MAX_RETRIES, lastReason });
  return { state: 'waiting', remaining: Math.max(0, link.remaining), status: 202, retryAfter: 1 };
}

/** Résout le PDF d'un ticket : prêt, en construction, ou à construire. */
export async function resolvePdf(ticket: TicketRow, link?: LinkRow): Promise<ClaimResult> {
  const cfg = config();
  const cacheId = `${ticket.docId}#${ticket.seqFrozen}`;
  const cache = await getItem<PdfCacheRow>(cfg.pdfCacheTable, { id: cacheId });
  const remaining = link ? Math.max(0, link.remaining) : 0;

  if (cache?.status === 'READY' && cache.s3Key) {
    const url = await presignedUrl(cache.s3Key, `${slug(link?.docTitle ?? 'document')}.pdf`);
    return { state: 'ready', ticket, seqFrozen: ticket.seqFrozen, url, remaining, status: 200 };
  }

  // Échec précédent de génération : on relance plutôt que de laisser le visiteur
  // attendre indéfiniment. Sans cela, un incident passager condamnerait tous les
  // visiteurs de cette version, ce qui revient à les « jeter » (interdit).
  if (cache?.status === 'FAILED') {
    const attempts = Number(cache.attempts ?? 0);
    if (attempts < 3) {
      try {
        await updateItem(
          cfg.pdfCacheTable,
          { id: cacheId },
          {
            update: 'SET #status = :building, attempts = :next',
            condition: '#status = :failed',
            names: { '#status': 'status' },
            values: { ':building': 'BUILDING', ':failed': 'FAILED', ':next': attempts + 1 },
          },
        );
        await triggerPdfBuild(ticket.docId, ticket.seqFrozen, cacheId);
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      }
      return { state: 'waiting', ticket, seqFrozen: ticket.seqFrozen, remaining, status: 202, retryAfter: 3 };
    }
    throw new ApiError(
      503,
      'PDF_UNAVAILABLE',
      'La génération du document a échoué plusieurs fois. Réessayez dans quelques instants.',
      { retryAfter: 10 },
    );
  }

  if (!cache) {
    const created: PdfCacheRow = {
      id: cacheId,
      docId: ticket.docId,
      seq: ticket.seqFrozen,
      status: 'BUILDING',
      attempts: 0,
      createdAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + PDF_TTL_SECONDS,
    };
    try {
      // Un seul claimant obtient le verrou et déclenche la génération.
      await putItem(cfg.pdfCacheTable, created as unknown as Record<string, unknown>, {
        condition: 'attribute_not_exists(id)',
      });
      await triggerPdfBuild(ticket.docId, ticket.seqFrozen, cacheId);
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }

  return { state: 'waiting', ticket, seqFrozen: ticket.seqFrozen, remaining, status: 202, retryAfter: 2 };
}

async function triggerPdfBuild(docId: string, seq: number, cacheId: string): Promise<void> {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const cfg = config();
  if (!cfg.pdfFunctionName) {
    console.warn('PDF_FUNCTION_NAME absent : génération PDF non déclenchée');
    return;
  }
  const client = new LambdaClient({ region: cfg.region });
  await client.send(
    new InvokeCommand({
      FunctionName: cfg.pdfFunctionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ docId, seq, cacheId })),
    }),
  );
}

/** `GET /d/{token}/file` : même logique que le claim, sans consommer. */
export async function fileForVisitor(token: string, visitorId: string): Promise<ClaimResult> {
  const ticket = await getItem<TicketRow>(config().ticketsTable, { token, visitorId });
  if (!ticket) throw gone('NO_TICKET', 'Aucun exemplaire réservé pour ce visiteur');
  const link = await getLink(token).catch(() => undefined);
  return resolvePdf(ticket, link);
}

export function slug(title: string): string {
  const clean = clampText(title, 80)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return clean || 'document';
}

export { pdfKey, utcDay };
