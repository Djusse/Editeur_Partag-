/**
 * Stockage objet : PDF et snapshots.
 *
 * Bucket **privé**, chiffré, accès public bloqué. Les téléchargements passent
 * par une URL présignée de 60 secondes.
 *
 * Un magasin en mémoire est injectable (tests et mode local), ce qui permet de
 * vérifier le parcours PDF complet sans compte AWS.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config';

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  presign(key: string, filename: string, ttlSeconds: number): Promise<string>;
}

let storeOverride: ObjectStore | null = null;
let client: S3Client | null = null;

export function setObjectStore(store: ObjectStore | null): void {
  storeOverride = store;
}

function s3(): S3Client {
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
  if (storeOverride) return storeOverride.put(key, body, contentType);
  await s3().send(
    new PutObjectCommand({
      Bucket: config().bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }),
  );
}

export async function getObject(key: string): Promise<Uint8Array> {
  if (storeOverride) return storeOverride.get(key);
  const out = await s3().send(new GetObjectCommand({ Bucket: config().bucket, Key: key }));
  return (await out.Body!.transformToByteArray()) as Uint8Array;
}

/** URL de téléchargement de courte durée : un exemplaire = un lien temporaire. */
export async function presignedUrl(
  key: string,
  filename: string,
  ttlSeconds = config().pdfUrlTtlSeconds,
): Promise<string> {
  if (storeOverride) return storeOverride.presign(key, filename, ttlSeconds);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: config().bucket,
      Key: key,
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\]/g, '')}"`,
    }),
    { expiresIn: ttlSeconds },
  );
}
