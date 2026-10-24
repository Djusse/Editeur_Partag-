/** Gestion des documents et des membres (partage par e-mail). */
import { config } from './config';
import { getItem, putItem, query, transactWrite, updateItem, deleteItem, scan } from './db';
import { badRequest, forbidden, notFound } from './errors';
import { clampText, isValidEmail, randomToken } from './ids';
import type { DocumentRow, MemberRow } from './types';

export function newDocId(): string {
  return `doc_${randomToken(9)}`;
}

export async function createDocument(input: {
  title: string;
  ownerEmail: string;
  ownerName: string;
}): Promise<DocumentRow> {
  const title = clampText(input.title, 200) || 'Document sans titre';
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
  await transactWrite([
    { put: { table: config().documentsTable, item: doc as unknown as Record<string, unknown>, condition: 'attribute_not_exists(docId)' } },
    {
      put: {
        table: config().membersTable,
        item: {
          docId: doc.docId,
          email: input.ownerEmail,
          role: 'owner',
          name: input.ownerName,
          addedAt: now,
        },
        condition: 'attribute_not_exists(email)',
      },
    },
  ]);
  return doc;
}

export async function getDocument(docId: string): Promise<DocumentRow> {
  const doc = await getItem<DocumentRow>(config().documentsTable, { docId });
  if (!doc) throw notFound('DOCUMENT_NOT_FOUND', 'Document introuvable');
  return doc;
}

export async function assertMember(docId: string, email: string): Promise<MemberRow> {
  const member = await getItem<MemberRow>(config().membersTable, { docId, email });
  if (!member) throw forbidden('NOT_A_MEMBER', 'Vous n\'avez pas accès à ce document');
  return member;
}

export async function requireDocumentAccess(docId: string, email: string): Promise<{ doc: DocumentRow; member: MemberRow }> {
  const doc = await getDocument(docId);
  const member = await assertMember(docId, email);
  return { doc, member };
}

/** Liste les documents auxquels l'utilisateur a accès (GSI email-index). */
export async function listDocumentsFor(email: string): Promise<Array<DocumentRow & { role: string }>> {
  const memberships = await query<MemberRow>({
    table: config().membersTable,
    index: 'email-index',
    keyCondition: 'email = :email',
    values: { ':email': email },
  });
  const docs: Array<DocumentRow & { role: string }> = [];
  await Promise.all(
    memberships.items.map(async (member) => {
      const doc = await getItem<DocumentRow>(config().documentsTable, { docId: member.docId });
      if (doc) docs.push({ ...doc, role: member.role });
    }),
  );
  return docs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function listMembers(docId: string): Promise<MemberRow[]> {
  const result = await query<MemberRow>({
    table: config().membersTable,
    keyCondition: 'docId = :docId',
    values: { ':docId': docId },
  });
  return result.items;
}

export async function addMember(input: {
  docId: string;
  email: string;
  name: string;
  addedBy: string;
}): Promise<MemberRow> {
  const email = input.email.trim().toLowerCase();
  if (!isValidEmail(email)) throw badRequest('INVALID_EMAIL', 'Adresse e-mail invalide');
  const member: MemberRow = {
    docId: input.docId,
    email,
    role: 'editor',
    name: clampText(input.name, 80) || email.split('@')[0],
    addedAt: new Date().toISOString(),
  };
  await putItem(config().membersTable, member as unknown as Record<string, unknown>, {
    condition: 'attribute_not_exists(email)',
  }).catch((error: unknown) => {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return;
    throw error;
  });
  return member;
}

export async function renameDocument(docId: string, title: string): Promise<void> {
  const nextTitle = clampText(title, 200);
  if (!nextTitle) throw badRequest('INVALID_TITLE', 'Titre vide');
  await updateItem(
    config().documentsTable,
    { docId },
    {
      update: 'SET title = :title, updatedAt = :now',
      condition: 'attribute_exists(docId)',
      values: { ':title': nextTitle, ':now': new Date().toISOString() },
    },
  );
}

export async function deleteDocument(docId: string): Promise<void> {
  await deleteItem(config().documentsTable, { docId });
  const members = await listMembers(docId);
  await Promise.all(members.map((member) => deleteItem(config().membersTable, { docId, email: member.email })));
}

/** Vue de supervision : tous les documents (usage admin). */
export async function scanDocuments(limit = 200): Promise<DocumentRow[]> {
  const result = await scan<DocumentRow>({ table: config().documentsTable, limit });
  return result.items;
}
