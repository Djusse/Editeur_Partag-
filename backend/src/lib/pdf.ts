/**
 * Génération du PDF (C3).
 *
 * Le document est reconstruit depuis le journal jusqu'à la `seq` **figée dans
 * le ticket** (T1), jamais depuis le texte courant : c'est l'exigence exacte du
 * sujet. La génération est **asynchrone** (worker SQS), donc aucun visiteur
 * n'attend dans une requête HTTP.
 *
 * Dépendance volontairement simple : `pdfkit` en texte brut, sans navigateur
 * headless (démarrage instantané, empreinte mémoire faible sur `t3.large`).
 */
import PDFDocument from 'pdfkit';
import * as Y from 'yjs';
import { config } from './config';
import { db } from './db';
import { getObject, pdfKey, putObject, snapshotKey } from './s3';
import type { DocumentRow, PdfCacheRow, UpdateRow } from './types';

const PAGE_MARGIN = 56;
const FONT_SIZE = 11;
const LINE_HEIGHT = 15;

/** Reconstruit le texte d'un document à une version donnée. */
export function textAtVersion(state: Uint8Array | undefined, updates: UpdateRow[]): string {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  for (const update of updates) Y.applyUpdate(doc, update.payload);
  return doc.getText('content').toString();
}

/** Charge l'état complet (snapshot + journal) jusqu'à `seq`. */
export async function loadStateUpTo(docId: string, seq: number): Promise<{ snapshot?: Uint8Array; updates: UpdateRow[] }> {
  const cfg = config();
  const doc = await db().get<DocumentRow>(cfg.documentsTable, { docId });

  let snapshot: Uint8Array | undefined;
  let from = 0;
  if (doc && doc.latestSnapshotSeq > 0 && doc.latestSnapshotSeq <= seq) {
    try {
      snapshot = await getObject(snapshotKey(docId, doc.latestSnapshotSeq));
      from = doc.latestSnapshotSeq;
    } catch {
      snapshot = undefined;
      from = 0;
    }
  }

  // DynamoDB ne permet pas de borne haute dans une KeyCondition sur le tri :
  // on lit depuis `from` et on filtre sur `seq <= seq` côté application.
  const updates: UpdateRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const page = await db().query<UpdateRow>(cfg.updatesTable, {
      keyCondition: 'docId = :docId AND seq > :from',
      values: { ':docId': docId, ':from': from },
      limit: 500,
      scanForward: true,
      exclusiveStartKey,
    });
    const reachedEnd = page.items.some((row) => row.seq > seq);
    for (const row of page.items) {
      if (row.seq > seq) break;
      updates.push(row);
    }
    exclusiveStartKey = reachedEnd ? undefined : page.lastKey;
    pages++;
  } while (exclusiveStartKey && pages < 40);

  return { snapshot, updates: updates.sort((a, b) => a.seq - b.seq) };
}

function sanitize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** Rend le PDF en mémoire. */
export function renderPdf(title: string, text: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(18).fillColor('#111827').text(sanitize(title).slice(0, 200));
      doc.moveDown(0.3);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#6B7280')
        .text(`Généré le ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
      doc.moveDown(1.2);

      doc.font('Helvetica').fontSize(FONT_SIZE).fillColor('#111827');
      const paragraphs = sanitize(text).split('\n');

      for (const paragraph of paragraphs) {
        if (paragraph.length === 0) {
          doc.moveDown(0.5);
          continue;
        }
        doc.text(paragraph, {
          width: 483,
          lineGap: LINE_HEIGHT - FONT_SIZE,
          align: 'left',
        });
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

export interface PdfJob {
  docId: string;
  seq: number;
  cacheId: string;
}

/**
 * Construit le PDF d'une version figée et le dépose dans S3.
 * Idempotent : la clé S3 est déterministe (`pdf/{docId}/v{seq}.pdf`).
 */
export async function buildPdf(job: PdfJob): Promise<void> {
  const cfg = config();
  const started = Date.now();

  const doc = await db().get<DocumentRow>(cfg.documentsTable, { docId: job.docId });
  if (!doc) throw new Error(`Document inconnu : ${job.docId}`);

  const { snapshot, updates } = await loadStateUpTo(job.docId, job.seq);
  const text = textAtVersion(snapshot, updates);
  const bytes = await renderPdf(doc.title, text);

  const key = pdfKey(job.docId, job.seq);
  await putObject(key, bytes, 'application/pdf');

  await db().update(
    cfg.pdfCacheTable,
    { id: job.cacheId },
    {
      update: 'SET #status = :ready, s3Key = :key, bytes = :bytes, buildMs = :ms',
      names: { '#status': 'status' },
      values: { ':ready': 'READY', ':key': key, ':bytes': bytes.length, ':ms': Date.now() - started },
    },
  );
}

/** Marque une génération en échec et libère le bail. */
export async function markPdfFailed(cacheId: string, error: unknown): Promise<void> {
  const existing = await db().get<PdfCacheRow>(config().pdfCacheTable, { id: cacheId });
  if (!existing) return;
  await db()
    .update(
      config().pdfCacheTable,
      { id: cacheId },
      {
        update: 'SET #status = :failed, #error = :error',
        names: { '#status': 'status', '#error': 'error' },
        values: { ':failed': 'FAILED', ':error': String((error as Error).message ?? error).slice(0, 400) },
      },
    )
    .catch(() => undefined);
}
