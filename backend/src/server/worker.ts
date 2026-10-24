/**
 * Worker PDF — consommateur SQS (processus `editeur-worker` sous systemd).
 *
 * Pourquoi un processus séparé : `pdfkit` et la reconstruction Yjs sont
 * gourmands en CPU. Les isoler protège la boucle d'événements du serveur, donc
 * la latence d'écriture collaborative (C2, C5).
 *
 * Garanties :
 *  - **idempotent** : la clé S3 est déterministe (`pdf/{docId}/v{seq}.pdf`) et
 *    l'état du cache est conditionnel ;
 *  - **long polling** (20 s) : peu d'appels à vide ;
 *  - **file de lettres mortes** après 3 essais (`maxReceiveCount` dans le
 *    template) : un PDF impossible ne boucle pas indéfiniment.
 */
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { config } from '../lib/config';
import { buildPdf, markPdfFailed, type PdfJob } from '../lib/pdf';

const VISIBILITY_TIMEOUT_SECONDS = 120;
const MAX_ATTEMPTS = 3;

async function main(): Promise<void> {
  const cfg = config();
  if (!cfg.pdfQueueUrl) {
    console.error('PDF_QUEUE_URL absent : worker inutile, arrêt.');
    process.exit(1);
  }

  const sqs = new SQSClient({ region: cfg.region });
  let running = true;

  process.on('SIGTERM', () => {
    running = false;
  });

  console.log('Worker PDF démarré');

  while (running) {
    const out = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: cfg.pdfQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
        // `ApproximateReceiveCount` s'obtient par `AttributeNames`, mais le SDK
        // exige le type d'énumération complet : on passe par une assertion.
        AttributeNames: ['ApproximateReceiveCount'] as never,
      }),
    );

    const message = out.Messages?.[0];
    if (!message?.Body || !message.ReceiptHandle) continue;

    let job: PdfJob | null = null;
    try {
      job = JSON.parse(message.Body) as PdfJob;
    } catch {
      console.error('Message PDF illisible, suppression', message.Body.slice(0, 200));
      await sqs.send(new DeleteMessageCommand({ QueueUrl: cfg.pdfQueueUrl, ReceiptHandle: message.ReceiptHandle }));
      continue;
    }

    const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? 1);

    try {
      await buildPdf(job);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: cfg.pdfQueueUrl, ReceiptHandle: message.ReceiptHandle }));
      console.log('PDF généré', { docId: job.docId, seq: job.seq });
    } catch (error) {
      console.error('Échec de génération', { job, attempts, error });
      if (attempts >= MAX_ATTEMPTS) {
        // Dernier essai : on marque l'échec pour que le visiteur reçoive un
        // message explicite au lieu d'attendre indéfiniment.
        await markPdfFailed(job.cacheId, error);
        await sqs.send(new DeleteMessageCommand({ QueueUrl: cfg.pdfQueueUrl, ReceiptHandle: message.ReceiptHandle }));
      } else {
        // On rend le message tout de suite pour retenter sans attendre le bail.
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: cfg.pdfQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
      }
    }
  }

  console.log('Worker PDF arrêté');
}

main().catch((error) => {
  console.error('Worker PDF : démarrage impossible', error);
  process.exit(1);
});
