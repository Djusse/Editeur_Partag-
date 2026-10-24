/**
 * Génération du PDF (C3) : le document est reconstruit à partir de la version
 * figée dans le ticket (`snapshot + updates ≤ seqFrozen`), jamais du texte
 * courant. La génération est asynchrone : aucun visiteur n'attend dans la
 * requête HTTP (API Gateway couperait à 29 s).
 */
import * as Y from 'yjs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { config } from './config';
import { getItem, updateItem } from './db';
import { putObject, pdfKey } from './s3';
import { loadDocumentState } from './updates';
import { getDocument } from './documents';
import type { PdfCacheRow } from './types';

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const FONT_SIZE = 11;
const LINE_HEIGHT = 16;
const MAX_CHARS_WRAP = 200;

/** Reconstruit le texte du document à la version demandée. */
export function textAtVersion(updates: Array<{ payload: Uint8Array }>, snapshot?: Uint8Array): string {
  const doc = new Y.Doc();
  if (snapshot) Y.applyUpdate(doc, snapshot);
  for (const update of updates) {
    Y.applyUpdate(doc, update.payload);
  }
  return doc.getText('content').toString();
}

/** Encode proprement le texte pour les polices standard (WinAnsi). */
function sanitize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

export async function renderPdf(title: string, text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('Éditeur de documents partagé');
  pdf.setProducer('pdf-lib');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  page.drawText(sanitize(title).slice(0, 200), {
    x: MARGIN,
    y,
    size: 18,
    font: bold,
    color: rgb(0.08, 0.1, 0.15),
  });
  y -= 24;
  page.drawText(`Généré le ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, {
    x: MARGIN,
    y,
    size: 9,
    font,
    color: rgb(0.45, 0.47, 0.5),
  });
  y -= 28;

  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  const paragraphs = sanitize(text).split('\n');

  for (const paragraph of paragraphs) {
    const words = paragraph.length > 0 ? paragraph.split(' ') : [''];
    let line = '';
    const flush = () => {
      if (y < MARGIN + LINE_HEIGHT) {
        page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
      page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0.1, 0.1, 0.12) });
      y -= LINE_HEIGHT;
    };
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate.slice(0, MAX_CHARS_WRAP), FONT_SIZE) > maxWidth && line) {
        flush();
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) flush();
    else {
      // Ligne vide : on garde un espacement de paragraphe.
      y -= LINE_HEIGHT / 2;
      if (y < MARGIN) {
        page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
    }
  }

  const bytes = await pdf.save();
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Handler asynchrone : construit le PDF d'une version figée et le dépose dans S3. */
export async function buildPdfForVersion(input: { docId: string; seq: number; cacheId: string }): Promise<void> {
  const cfg = config();
  const started = Date.now();
  try {
    const doc = await getDocument(input.docId);
    const state = await loadDocumentState(input.docId);
    // On ne garde que les updates ≤ seq figée : c'est la garantie C3.
    const updates = state.updates.filter((update) => update.seq <= input.seq);
    const text = textAtVersion(updates, state.snapshot);
    const bytes = await renderPdf(doc.title, text);
    const key = pdfKey(input.docId, input.seq);
    await putObject(key, bytes, 'application/pdf');
    await updateItem(
      cfg.pdfCacheTable,
      { id: input.cacheId },
      {
        update: 'SET #status = :ready, s3Key = :key, bytes = :bytes, buildMs = :ms',
        names: { '#status': 'status' },
        values: { ':ready': 'READY', ':key': key, ':bytes': bytes.length, ':ms': Date.now() - started },
      },
    );
  } catch (error) {
    console.error('Échec de génération du PDF', { input, error });
    const existing = await getItem<PdfCacheRow>(cfg.pdfCacheTable, { id: input.cacheId });
    if (existing) {
      await updateItem(
        cfg.pdfCacheTable,
        { id: input.cacheId },
        {
          update: 'SET #status = :failed, #error = :error',
          names: { '#status': 'status', '#error': 'error' },
          values: { ':failed': 'FAILED', ':error': (error as Error).message.slice(0, 500) },
        },
      ).catch(() => undefined);
    }
    throw error;
  }
}
