/**
 * Session WebSocket pour les scénarios k6, sur l'API `k6/ws`.
 *
 * Pourquoi **`k6/ws`** et pas autre chose : la première version de S2 utilisait
 * `new WebSocket(url)` comme dans un navigateur, ce qui lève
 * `ReferenceError: WebSocket is not defined` — k6 n'expose aucun `WebSocket`
 * global. Le remède évident (`k6/experimental/websocket`) est un piège : vérifié
 * au banc sur k6 v0.54.0, les deux modules suivants sont **inconnus**
 *
 *     k6/experimental/websocket   → unknown module
 *     k6/websocket                → unknown module
 *     k6/ws                       → OK
 *
 * et `k6/websocket` n'apparaît qu'à partir de k6 v1.0. Autrement dit, choisir
 * l'un des deux premiers casse le test sur la moitié des versions installables.
 * `k6/ws` existe depuis 0.41 et son API (`ws.connect`) n'a pas changé depuis :
 * c'est le seul choix qui fonctionne sur toute la plage de versions.
 *
 * Différences avec l'API navigateur, qui expliquent la forme de ce fichier :
 *   - pas d'événements : `ws.connect(url, params, (socket) => …)` rend la main
 *     sur un objet `socket` qu'on pilote par méthodes ;
 *   - `socket.on('message', (data) => …)` au lieu de `socket.onmessage` ;
 *   - `socket.setTimeout(fn, ms)` remplace `setTimeout` pour l'attente bornée ;
 *   - la fonction de rappel doit **rester** active pendant l'échange : en sortir
 *     ferme la connexion.
 */
import ws from 'k6/ws';

/** Convertit une base HTTP en base WebSocket (`http://x` → `ws://x`). */
export function wsBase(apiUrl) {
  return (apiUrl || 'http://localhost:4000').replace(/\/+$/, '').replace(/^http/, 'ws');
}

/**
 * Ouvre une session d'écriture et attend ses acquittements.
 *
 * @param {object}   options
 * @param {string}   options.url          URL `ws(s)://…/ws?ticket=…&documentId=…`
 * @param {number}   options.sinceSeq     premier `seq` manquant (0 = tout le journal)
 * @param {number}   options.count        nombre d'updates à émettre une fois joint
 * @param {string}   options.updateB64    update Yjs encodé, 1 caractère facturé
 * @param {string}   options.opPrefix     préfixe d'`opId`, unique par VU et par itération
 * @param {number}   options.ackWaitMs    délai de garde avant de conclure à une perte
 * @param {Function} options.onUpdate     appelé sur chaque `update` diffusé
 * @param {Function} options.onAck        appelé avec (latenceMs) par `opId` acquitté
 * @param {Function} options.onError      appelé avec le message d'erreur serveur
 * @param {Function} options.onOpen       appelé à l'ouverture (compteurs de diagnostic)
 *
 * @returns {{joined:boolean, acked:number, missing:number, errored:boolean,
 *            durationMs:number, creditRefused:boolean}}
 *
 * `missing` est le cœur de la preuve C2 : c'est le nombre d'updates émis dont
 * l'`ack` n'est jamais revenu dans le délai de garde. Non nul, il signifie
 * qu'une modification a été acceptée sans confirmation — donc perdue, ou sur le
 * point de l'être.
 */
export function runWriterSession(options) {
  const {
    url,
    sinceSeq = 0,
    count = 2,
    updateB64,
    opPrefix,
    ackWaitMs = 2500,
    onUpdate,
    onAck,
    onError,
    onOpen,
  } = options;

  const result = {
    joined: false,
    acked: 0,
    missing: 0,
    errored: false,
    creditRefused: false,
    durationMs: 0,
  };

  const sentAt = new Map();
  const startedAt = Date.now();

  ws.connect(url, {}, (socket) => {
    if (onOpen) onOpen();

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'join', documentId: options.docId, sinceSeq }));
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
        // Écriture immédiate après `joined` : c'est le comportement du vrai
        // client, qui n'attend pas pour taper.
        for (let index = 0; index < count; index++) {
          const opId = `${opPrefix}_${index}`;
          sentAt.set(opId, Date.now());
          socket.send(
            JSON.stringify({
              type: 'update',
              opId,
              documentId: options.docId,
              payload: updateB64,
            }),
          );
        }
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
        // Tous acquittés : plus rien à attendre, on ferme sans épuiser le délai.
        if (sentAt.size === 0) socket.close();
        return;
      }

      if (message.type === 'error') {
        result.errored = true;
        if (message.code === 'CREDIT_EXHAUSTED' || message.code === 'BLOCKED') {
          // Refus explicite : ce n'est pas une perte d'update. On distingue les
          // deux, sinon un palier à 300 rédacteurs ferait croire à une
          // violation de C2 alors qu'il n'y a qu'un quota épuisé.
          result.creditRefused = true;
          socket.close();
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
    socket.setTimeout(() => {
      socket.close();
    }, ackWaitMs);
  });

  result.missing = sentAt.size;
  result.durationMs = Date.now() - startedAt;
  return result;
}
