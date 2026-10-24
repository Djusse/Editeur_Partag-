/**
 * Point d'entrée du serveur applicatif (processus `editeur-app` sous systemd).
 *
 * Fastify gère le REST ; `ws` gère le WebSocket sur `/ws`. Les deux partagent
 * le **même processus**, donc le même état en mémoire : c'est ce qui autorise
 * l'écrivain unique par document.
 */
import { WebSocketServer } from 'ws';
import { config } from '../lib/config';
import { jwtSecret } from '../lib/secrets';
import { buildApp } from './app';
import { attachProtocol } from '../realtime/protocol';
import { startTicketSweeper } from '../realtime/tickets';
import { manager } from '../realtime/manager';
import { setLastSeqReader } from '../lib/links';

async function main(): Promise<void> {
  const cfg = config();
  const app = buildApp();

  // Vérifie l'accès aux secrets au démarrage : mieux vaut échouer tout de suite
  // (systemd redémarrera) que de renvoyer des 500 à la première requête.
  await jwtSecret();

  // T1 s'appuie sur le `seq` réellement écrit : le hub en mémoire est la
  // source la plus fraîche, la table `Documents` sert de repli.
  setLastSeqReader((docId) => manager.lastSeq(docId));

  await app.listen({ port: cfg.port, host: cfg.host });

  const wss = new WebSocketServer({ server: app.server, path: '/ws', maxPayload: 2 * 1024 * 1024 });
  attachProtocol(wss);

  startTicketSweeper();

  console.log(`Serveur prêt : http://${cfg.host}:${cfg.port} (WebSocket sur /ws)`);

  const shutdown = async (signal: string) => {
    console.log(`Arrêt demandé (${signal})`);
    // Arrêt propre : on laisse le hub écrire ce qui est en file.
    for (const doc of manager.openDocuments()) {
      const state = manager.get(doc.docId);
      if (state) {
        try {
          await state.flush();
        } catch (error) {
          console.error('Échec du vidage final', { docId: doc.docId, error });
        }
      }
    }
    manager.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('Démarrage impossible', error);
  process.exit(1);
});
