/**
 * Documents et partage.
 *
 * La table `Documents` ne se lit que par `docId` : pour lister les documents
 * d'un rédacteur, on interroge la table `Members` (index `email-index`), ce que
 * la spécification d'interface exige (section 4.1).
 */
import { config } from './config';
import { db } from './db';
import { forbidden, invalidInput, notFound } from './errors';
import { clampText, isValidEmail, newDocId } from './ids';
import type { DocumentRow, MemberRow } from './types';

export const TITLE_MAX = 120;
export const NAME_MAX = 60;

export async function createDocument(input: {
  title: string;
  ownerEmail: string;
  ownerName: string;
}): Promise<DocumentRow> {
  const title = clampText(input.title, TITLE_MAX);
  if (!title) throw invalidInput('title', 'Donnez un titre au document.');

  const now = new Date().toISOString();
  const doc: DocumentRow = {
    docId: newDocId(),
    title,
    ownerEmail: input.ownerEmail,
    ownerName: input.ownerName,
    seq: 0,
    latestSnapshotSeq: 0,
    textLength: 0,
    createdAt: now,
    updatedAt: now,
  };

  await db().transact([
    {
      Put: {
        table: config().documentsTable,
        item: doc as unknown as Record<string, unknown>,
        condition: 'attribute_not_exists(docId)',
      },
    },
    {
      Put: {
        table: config().membersTable,
        item: {
          docId: doc.docId,
          email: input.ownerEmail,
          name: input.ownerName,
          role: 'owner',
          addedAt: now,
        },
        condition: 'attribute_not_exists(email)',
      },
    },
  ]);

  return doc;
}

export async function getDocument(docId: string): Promise<DocumentRow> {
  const doc = await db().get<DocumentRow>(config().documentsTable, { docId });
  if (!doc) throw notFound('Document introuvable.');
  return doc;
}

export async function getMembership(docId: string, email: string): Promise<MemberRow | undefined> {
  return db().get<MemberRow>(config().membersTable, { docId, email });
}

/** Vérifie l'appartenance ; renvoie le document et le membre. */
export async function requireAccess(
  docId: string,
  email: string,
): Promise<{ doc: DocumentRow; member: MemberRow }> {
  const doc = await getDocument(docId);
  const member = await getMembership(docId, email);
  if (!member) throw forbidden('Vous n\'avez pas accès à ce document.');
  return { doc, member };
}

export async function listDocumentsFor(email: string): Promise<
  Array<{ id: string; title: string; ownerName: string; ownerEmail: string; updatedAt: string; role: string }>
> {
  const memberships = await db().query<MemberRow>(config().membersTable, {
    index: 'email-index',
    keyCondition: 'email = :email',
    values: { ':email': email },
  });

  const docs = await Promise.all(
    memberships.items.map(async (member) => {
      const doc = await db().get<DocumentRow>(config().documentsTable, { docId: member.docId });
      if (!doc) return null;
      return {
        id: doc.docId,
        title: doc.title,
        ownerName: doc.ownerName,
        ownerEmail: doc.ownerEmail,
        updatedAt: doc.updatedAt,
        role: member.role,
      };
    }),
  );

  return docs
    .filter((doc): doc is NonNullable<typeof doc> => doc !== null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function listMembers(docId: string): Promise<Array<{ email: string; name: string; role: string }>> {
  const result = await db().query<MemberRow>(config().membersTable, {
    keyCondition: 'docId = :docId',
    values: { ':docId': docId },
  });
  return result.items
    .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.email.localeCompare(b.email)))
    .map((member) => ({ email: member.email, name: member.name, role: member.role }));
}

/** Ajoute un membre ; une personne déjà membre n'est pas une erreur bloquante. */
export async function addMember(docId: string, rawEmail: string, addedBy: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!isValidEmail(email)) throw invalidInput('email', 'Adresse e-mail invalide.');

  const existing = await getMembership(docId, email);
  if (existing) throw new AppErrorAlreadyMember(email);

  await db().put(
    config().membersTable,
    {
      docId,
      email,
      name: email.split('@')[0],
      role: 'editor',
      addedAt: new Date().toISOString(),
    },
    { condition: 'attribute_not_exists(email)' },
  ).catch((error: unknown) => {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new AppErrorAlreadyMember(email);
    }
    throw error;
  });

  void addedBy;
}

/** Signalée à part pour que la route réponde `409 ALREADY_MEMBER`. */
export class AppErrorAlreadyMember extends Error {
  readonly email: string;
  constructor(email: string) {
    super('Cette personne a déjà accès.');
    this.name = 'AppErrorAlreadyMember';
    this.email = email;
  }
}

/** Met à jour les métadonnées de séquence d'un document (utilisé par le hub). */
export async function touchDocument(
  docId: string,
  changes: { seq?: number; latestSnapshotSeq?: number; textLength?: number },
): Promise<void> {
  const sets: string[] = ['updatedAt = :now'];
  const values: Record<string, unknown> = { ':now': new Date().toISOString() };

  if (changes.seq !== undefined) {
    sets.push('seq = :seq');
    values[':seq'] = changes.seq;
  }
  if (changes.latestSnapshotSeq !== undefined) {
    sets.push('latestSnapshotSeq = :snap');
    values[':snap'] = changes.latestSnapshotSeq;
  }
  if (changes.textLength !== undefined) {
    sets.push('textLength = :len');
    values[':len'] = changes.textLength;
  }

  await db().update(
    config().documentsTable,
    { docId },
    { update: `SET ${sets.join(', ')}`, values },
  );
}

export async function renameDocument(docId: string, title: string): Promise<void> {
  const next = clampText(title, TITLE_MAX);
  if (!next) throw invalidInput('title', 'Donnez un titre au document.');
  await db().update(
    config().documentsTable,
    { docId },
    { update: 'SET title = :title, updatedAt = :now', values: { ':title': next, ':now': new Date().toISOString() } },
  );
}
