/** Accès S3 : PDF, snapshots CRDT et URL présignées courtes (60 s). */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config';

let client: S3Client | null = null;

/** Réservé aux tests : remplace la signature d'URL (aucun appel AWS). */
let presignerOverride: ((key: string, filename: string, ttlSeconds: number) => Promise<string>) | null = null;

export function setPresignerOverride(
  override: ((key: string, filename: string, ttlSeconds: number) => Promise<string>) | null,
): void {
  presignerOverride = override;
}

/**
 * Réservé au mode local : remplace le stockage objet par une implémentation en
 * mémoire. Permet de tester le parcours PDF complet sans compte AWS.
 */
export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

let objectStoreOverride: ObjectStore | null = null;

export function setObjectStore(store: ObjectStore | null): void {
  objectStoreOverride = store;
}

export function s3(): S3Client {
  if (!client) client = new S3Client({ region: config().region });
  return client;
}

export function pdfKey(docId: string, seq: number): string {
  return `pdf/${docId}/v${seq}.pdf`;
}

export function snapshotKey(docId: string, seq: number): string {
  return `snapshots/${docId}/${String(seq).padStart(10, '0')}.bin`;
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  if (objectStoreOverride) return objectStoreOverride.put(key, body, contentType);
  await s3().send(
    new PutObjectCommand({
      Bucket: config().pdfBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }),
  );
}

export async function getObject(key: string): Promise<Uint8Array> {
  if (objectStoreOverride) return objectStoreOverride.get(key);
  const out = await s3().send(new GetObjectCommand({ Bucket: config().pdfBucket, Key: key }));
  return (await out.Body!.transformToByteArray()) as Uint8Array;
}

/** URL présignée de courte durée : un exemplaire = un lien temporaire. */
export async function presignedUrl(key: string, filename: string, ttlSeconds = config().pdfUrlTtlSeconds): Promise<string> {
  if (presignerOverride) return presignerOverride(key, filename, ttlSeconds);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: config().pdfBucket,
      Key: key,
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
    }),
    { expiresIn: ttlSeconds },
  );
}
