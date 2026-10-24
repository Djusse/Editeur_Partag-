/**
 * File SQS des générations PDF.
 *
 * Pourquoi une file : la génération peut prendre plusieurs secondes sur un gros
 * document. La sortir de la requête du visiteur est ce qui permet de répondre
 * `202 waiting` immédiatement, et la file absorbe un pic de 500 visiteurs
 * simultanés (un seul message par version, grâce au verrou `BUILDING`).
 *
 * En local, l'implémentation est en mémoire : le job est exécuté aussitôt en
 * tâche de fond, ce qui reproduit exactement le comportement observable
 * (`waiting` puis `ready`).
 */
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from './config';
import type { PdfJob } from './pdf';

export interface JobQueue {
  enqueue(job: PdfJob): Promise<void>;
}

let override: JobQueue | null = null;
let client: SQSClient | null = null;

export function setJobQueue(queue: JobQueue | null): void {
  override = queue;
}

class SqsQueue implements JobQueue {
  private sqs: SQSClient | null = null;

  async enqueue(job: PdfJob): Promise<void> {
    const url = config().pdfQueueUrl;
    if (!url) {
      // Pas de file configurée : on ne bloque pas le visiteur pour autant.
      console.warn('PDF_QUEUE_URL absent : génération PDF non déclenchée');
      return;
    }
    if (!this.sqs) this.sqs = new SQSClient({ region: config().region });
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: JSON.stringify(job),
        // Regroupement par version : un seul message utile par (docId, seq).
        MessageAttributes: {
          docId: { DataType: 'String', StringValue: job.docId },
        },
      }),
    );
  }
}

export function jobQueue(): JobQueue {
  if (override) return override;
  if (!client) {
    client = new SQSClient({ region: config().region });
    const queue = new SqsQueue();
    return queue;
  }
  return new SqsQueue();
}
