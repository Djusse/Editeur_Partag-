/**
 * Session WebSocket pour les scénarios k6, sur l'API `k6/ws`.
 *
 * ── Pourquoi `k6/ws` et pas autre chose ─────────────────────────────────────
 * La première version de S2 utilisait `new WebSocket(url)` comme dans un
 * navigateur : `ReferenceError: WebSocket is not defined`. k6 n'expose aucun
 * `WebSocket` global. Le remède évident (`k6/experimental/websocket`) est un
 * piège : vérifié au banc sur k6 **v0.54.0**, les modules suivants sont inconnus
 *
 *     WebSocket (global)          → not defined
 *     k6/experimental/websocket   → unknown module
 *     k6/websocket                → unknown module  (n'existe qu'à partir de v1.0)
 *     k6/ws                       → OK
 *
 * `k6/ws` existe depuis la 0.41 et son API n'a pas changé : c'est le seul choix
 * qui fonctionne sur toute la plage de versions installables.
 *
 * Différences avec l'API navigateur, qui expliquent la forme de ce fichier :
 *   - `ws.connect(url, params, (socket) => …)` rend un objet `socket` ;
 *   - `socket.on('message', fn)` au lieu de `socket.onmessage` ;
 *   - `socket.setInterval` / `socket.setTimeout` au lieu des timers globaux ;
 *   - le rappel doit **rester actif** pendant l'échange : en sortir ferme.
 *
 * ── Pourquoi une cadence, et pourquoi persistante ───────────────────────────
 * Une première version ouvrait une connexion, envoyait N updates, attendait les
 * `ack`, puis recommençait. Au banc, chaque VU bouclait alors ~110 fois par
 * seconde. Trois conséquences, toutes rédhibitoires :
 *
 *   1. **Le crédit explosait.** À 2 caractères par itération et 110 itérations
 *      par seconde, un seul VU consommait 220 caractères/s : les 10 000
 *      caractères quotidiens partaient en 45 s, et le test mesurait le blocage
 *      de crédit au lieu de la convergence.
 *   2. **Ce n'était pas le bon profil de charge.** Un rédacteur réel garde sa
 *      connexion ouverte et tape quelques caractères par seconde. Ouvrir et
 *      fermer une connexion par update teste la poignée de main WebSocket, pas
 *      le hub.
 *   3. **La latence était faussée** par le rejeu du journal à chaque connexion.
 *
 * La session est donc **persistante** : une connexion par VU, un update toutes
 * les `paceMs`, pendant `durationMs`. C'est la charge réelle, et le budget de
 * crédit devient calculable : `durationMs / paceMs` caractères par VU.
 */
import ws from 'k6/ws';

/** Convertit une base HTTP en base WebSocket (`http://x` → `ws://x`). */
export function wsBase(apiUrl) {
  return (apiUrl || 'http://localhost:4000').replace(/\/+$/, '').replace(/^http/, 'ws');
}

/**
 * Ouvre une session d'écriture persistante et compte ses acquittements.
 *
 * @param {object}   options
 * @param {string}   options.url         URL `ws(s)://…/ws?ticket=…&documentId=…`
 * @param {string}   options.docId       identifiant du document (messages `join`/`update`)
 * @param {number}   options.sinceSeq    premier `seq` manquant (0 = tout le journal)
 * @param {number}   options.paceMs      intervalle entre deux updates
 * @param {number}   options.durationMs  durée d'écriture avant d'arrêter
 * @param {string}   options.updateB64   update Yjs encodé, 1 caractère facturé
 * @param {string}   options.opPrefix    préfixe d'`opId`, unique par VU et itération
 * @param {number}   options.ackWaitMs   sursis laissé aux `ack` en vol après l'arrêt
 * @param {Function} options.onUpdate    appelé sur chaque `update` diffusé
 * @param {Function} options.onAck       appelé avec (latenceMs) par `opId` acquitté
 * @param {Function} options.onError     appelé avec le message d'erreur serveur
 *
 * @returns {{joined:boolean, sent:number, acked:number, missing:number,
 *            errored:boolean, creditRefused:boolean, durationMs:number}}
 *
 * `missing` est le cœur de la preuve C2 : nombre d'updates émis dont l'`ack`
 * n'est jamais revenu. Non nul, il signifie qu'une modification a été acceptée
 * sans confirmation — donc perdue, ou sur le point de l'être.
 */
export function runWriterSession(options) {
  const {
    url,
    docId,
    sinceSeq = 0,
    paceMs = 1000,
    durationMs = 45000,
    updateB64,
    opPrefix,
    ackWaitMs = 2500,
    onUpdate,
    onAck,
    onError,
  } = options;

  const result = {
    joined: false,
    sent: 0,
    acked: 0,
    missing: 0,
    errored: false,
    creditRefused: false,
    durationMs: 0,
  };

  const sentAt = new Map();
  const startedAt = Date.now();
  /** Identifiant unique par envoi, même à opId préfixé constant. */
  let counter = 0;

  ws.connect(url, {}, (socket) => {
    let stopped = false;

    const sendOne = () => {
      if (stopped || !result.joined) return;
      counter += 1;
      const opId = `${opPrefix}_${counter}`;
      sentAt.set(opId, Date.now());
      result.sent += 1;
      socket.send(JSON.stringify({ type: 'update', opId, documentId: docId, payload: updateB64 }));
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      // On laisse un sursis aux `ack` en vol : fermer immédiatement
      // transformerait toute update en retard en « update perdue », et le test
      // conclurait à une violation de C2 pour une simple latence réseau.
      socket.setTimeout(() => socket.close(), ackWaitMs);
    };

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'join', documentId: docId, sinceSeq }));
    });

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        return;
      }

      if (message.type === 'joined') {
        result.joined = true;
        // Premier envoi immédiat, puis cadence régulière : c'est le
        // comportement d'un client qui tape sans attendre.
        sendOne();
        socket.setInterval(sendOne, paceMs);
        socket.setTimeout(stop, durationMs);
        return;
      }

      if (message.type === 'update') {
        if (onUpdate) onUpdate(message);
        return;
      }

      if (message.type === 'ack' && Array.isArray(message.opIds)) {
        for (const opId of message.opIds) {
          const at = sentAt.get(opId);
          if (at === undefined) continue;
          sentAt.delete(opId);
          result.acked += 1;
          if (onAck) onAck(Date.now() - at);
        }
        return;
      }

      if (message.type === 'error') {
        result.errored = true;
        if (message.code === 'CREDIT_EXHAUSTED' || message.code === 'BLOCKED') {
          // Refus explicite : ce n'est pas une perte d'update. On distingue les
          // deux, sinon un palier élevé ferait croire à une violation de C2
          // alors qu'il n'y a qu'un quota épuisé.
          result.creditRefused = true;
          stop();
          return;
        }
        // L'update refusé ne recevra jamais d'ack : on le sort de l'attente,
        // sans quoi il serait compté deux fois (rejeté **et** perdu).
        if (typeof message.opId === 'string') sentAt.delete(message.opId);
        if (onError) onError(message);
      }
    });

    socket.on('error', () => {
      result.errored = true;
    });

    // Filet de sécurité : sans cette fermeture, une connexion qui n'obtient
    // jamais `joined` bloquerait le VU jusqu'à la fin du test.
    socket.setTimeout(() => socket.close(), durationMs + ackWaitMs + 1000);
  });

  result.missing = sentAt.size;
  result.durationMs = Date.now() - startedAt;
  return result;
}
