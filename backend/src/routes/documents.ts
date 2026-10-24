/**
 * Documents, membres, état et repli HTTP de l'édition.
 *
 * Les identifiants exposés sont `id` (contrat d'interface, section 3.1) alors
 * que la clé DynamoDB est `docId` : la conversion se fait ici, une fois.
 */
import * as Y from 'yjs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { base64ToBytes, base64Size } from '../lib/base64';
import { config } from '../lib/config';
import { db } from '../lib/db';
import { AppError, invalidInput, unauthorized } from '../lib/errors';
import { isValidEmail, utcDay } from '../lib/ids';
import { verifySession, bearer } from '../lib/jwt';
import {
  AppErrorAlreadyMember,
  addMember,
  createDocument,
  getDocument,
  listDocumentsFor,
  listMembers,
  requireAccess,
} from '../lib/documents';
import { getCreditState } from '../lib/credits';
import { manager } from '../realtime/manager';
import { commitBatch, hashOf, type Client } from '../realtime/hub';
import { creditCost } from '../lib/yjs-update';

export interface Authenticated {
  email: string;
  name: string;
}

/** Session obligatoire sur toutes les routes du rédacteur. */
export async function requireUser(request: FastifyRequest): Promise<Authenticated> {
  const token = bearer(request.headers.authorization);
  try {
    const session = await verifySession(token);
    return { email: session.email, name: session.name };
  } catch (error) {
    throw error instanceof AppError ? error : unauthorized();
  }
}

export function registerDocumentRoutes(app: FastifyInstance): void {
  // --- Liste --------------------------------------------------------------
  app.get('/documents', async (request) => {
    const user = await requireUser(request);
    const documents = await listDocumentsFor(user.email);
    return { documents };
  });

  // --- Création -----------------------------------------------------------
  app.post('/documents', async (request, reply) => {
    const user = await requireUser(request);
    const body = (request.body ?? {}) as { title?: unknown };
    const doc = await createDocument({
      title: typeof body.title === 'string' ? body.title : '',
      ownerEmail: user.email,
      ownerName: user.name,
    });
    reply.code(201);
    return { id: doc.docId, title: doc.title };
  });

  // --- Détail -------------------------------------------------------------
  app.get('/documents/:id', async (request) => {
    const user = await requireUser(request);
    const { id } = request.params as { id: string };
    const { doc } = await requireAccess(id, user.email);
    const members = await listMembers(id);
    return {
      id: doc.docId,
      title: doc.title,
      ownerEmail: doc.ownerEmail,
      ownerName: doc.ownerName,
      members,
    };
  });

  // --- État initial complet ----------------------------------------------
  // Nécessaire à l'interface (section 4.1) : un nouveau client doit recevoir
  // l'état Yjs complet, pas seulement un numéro de séquence.
  app.get('/documents/:id/state', async (request) => {
    const user = await requireUser(request);
    const { id } = request.params as { id: string };
    await requireAccess(id, user.email);
    const { seq, state } = await manager.stateUpTo(id);
    return { seq, state: Buffer.from(state).toString('base64') };
  });

  // --- Membres ------------------------------------------------------------
  app.post('/documents/:id/members', async (request) => {
    const user = await requireUser(request);
    const { id } = request.params as { id: string };
    await requireAccess(id, user.email);
    const body = (request.body ?? {}) as { email?: unknown };

    if (typeof body.email !== 'string' || !isValidEmail(body.email.trim().toLowerCase())) {
      throw invalidInput('email', 'Adresse e-mail invalide.');
    }

    try {
      await addMember(id, body.email, user.email);
    } catch (error) {
      if (error instanceof AppErrorAlreadyMember) {
        throw new AppError(409, 'ALREADY_MEMBER', 'Cette personne a déjà accès.');
      }
      throw error;
    }

    return { members: await listMembers(id) };
  });

  // --- Repli HTTP de l'édition -------------------------------------------
  // Mêmes règles que le WebSocket : même transaction, même crédit, même
  // idempotence. C'est ce qui garantit C2 même sans WebSocket.
  app.post('/documents/:id/updates', async (request) => {
    const user = await requireUser(request);
    const { id } = request.params as { id: string };
    await requireAccess(id, user.email);

    const body = (request.body ?? {}) as { opId?: unknown; update?: unknown };
    const opId = typeof body.opId === 'string' ? body.opId.trim() : '';
    if (!opId || opId.length > 100) throw invalidInput('opId', 'opId obligatoire (max 100 caractères).');

    const payloadBase64 = typeof body.update === 'string' ? body.update : '';
    if (!payloadBase64) throw invalidInput('update', 'Update absent.');
    if (base64Size(payloadBase64) > config().maxUpdateBytes) {
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Cette modification est trop volumineuse et n\'a pas été enregistrée.');
    }

    const payload = base64ToBytes(payloadBase64);
    let counts: { inserted: number; deleted: number; structs: number };
    try {
      counts = creditCost(payload).counts;
    } catch {
      throw invalidInput('update', 'Update illisible.');
    }

    const state = await manager.load(id);
    const fakeSocket = { readyState: 1, send: () => undefined } as never;
    const client: Client = {
      id: `http_${opId}`,
      socket: fakeSocket,
      email: user.email,
      name: user.name,
      color: '#2563EB',
      docId: id,
      seq: state.seq,
      cursor: null,
    };

    await commitBatch(state, [
      {
        client,
        opId,
        payload,
        chars: counts.inserted + counts.deleted,
        inserted: counts.inserted,
        deleted: counts.deleted,
        hash: hashOf(payload),
      },
    ]);

    const credit = await getCreditState(user.email);
    return {
      ack: {
        opIds: [opId],
        seq: state.seq,
        creditRemaining: credit.remaining,
      },
    };
  });

  // --- Rattrapage ---------------------------------------------------------
  app.get('/documents/:id/updates', async (request) => {
    const user = await requireUser(request);
    const { id } = request.params as { id: string };
    await requireAccess(id, user.email);
    const query = request.query as { since?: string };
    const since = Number(query.since ?? 0);
    const updates = await manager.updatesSince(id, Number.isFinite(since) ? since : 0);
    return {
      updates: updates.map((update) => ({
        seq: update.seq,
        payload: Buffer.from(update.payload).toString('base64'),
      })),
    };
  });

  // --- Crédit -------------------------------------------------------------
  app.get('/me/credit', async (request) => {
    const user = await requireUser(request);
    return getCreditState(user.email);
  });

  // --- Liens : liste ------------------------------------------------------
  app.get('/documents/:id/links', async (request) => {
    const user = await requireUser(request);
    const { id } = request.params as { id: string };
    await requireAccess(id, user.email);
    const { listLinks } = await import('../lib/links');
    const links = await listLinks(id);
    return {
      links: links.map((link) => ({
        token: link.token,
        maxDownloads: link.maxDownloads,
        remaining: link.remaining,
        status: link.status,
        createdAt: link.createdAt,
      })),
    };
  });

  // --- Versions -----------------------------------------------------------
  app.get('/documents/:id/versions', async (request) => {
    const user = await requireUser(request);
    const { id } = request.params as { id: string };
    await requireAccess(id, user.email);
    const { listVersions } = await import('../lib/versions');
    return { versions: await listVersions(id) };
  });

  /**
   * Enregistre une version **maintenant**.
   *
   * Le plan v7 prévoit des versions automatiques (50 entrées ou 2 minutes
   * d'activité) et la spécification d'interface n'affiche aucun bouton de
   * création. En pratique, un document fraîchement créé n'a donc aucune version
   * et la modale paraît cassée. Le sujet exige de pouvoir **consulter et
   * restaurer** des versions : on garde l'automatisme et l'on ajoute un
   * enregistrement explicite, à la demande. Écart documenté dans le README.
   */
  app.post('/documents/:id/versions', async (request, reply) => {
    const user = await requireUser(request);
    const { id } = request.params as { id: string };
    await requireAccess(id, user.email);

    const { saveVersion } = await import('../lib/versions');
    const state = await manager.load(id);
    const snapshot = Y.encodeStateAsUpdate(state.ydoc);
    const seq = state.seq;

    await saveVersion({
      docId: id,
      seq,
      state: snapshot,
      chars: state.ydoc.getText('content').length,
      authorEmail: user.email,
      authorName: user.name,
    });

    reply.code(201);
    return { version: { n: seq, chars: state.textLength, createdAt: new Date().toISOString() } };
  });

  app.post('/documents/:id/versions/:n/restore', async (request) => {
    const user = await requireUser(request);
    const { id, n } = request.params as { id: string; n: string };
    await requireAccess(id, user.email);
    const { restoreVersion } = await import('../lib/versions');
    const seq = await restoreVersion(id, Number(n), user.email, user.name);
    return { seq };
  });

  // --- Diagnostic interne (utile au mode local et aux tests) --------------
  app.get('/__internal/tables', async () => {
    const cfg = config();
    const rows = await Promise.all(
      [
        ['Documents', cfg.documentsTable],
        ['Updates', cfg.updatesTable],
        ['Links', cfg.linksTable],
        ['Tickets', cfg.ticketsTable],
        ['Credits', cfg.creditsTable],
      ].map(async ([label, table]) => [label, (await db().scan(table)).length] as const),
    );
    return { day: utcDay(), tables: Object.fromEntries(rows) };
  });
}

/** Cible des tests : permet de lire un document sans passer par HTTP. */
export async function readDocument(docId: string, email: string) {
  const { doc } = await requireAccess(docId, email);
  return doc;
}
