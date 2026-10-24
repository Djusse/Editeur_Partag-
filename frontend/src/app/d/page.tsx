'use client';

/**
 * Page de téléchargement (section 10).
 *
 * Machine à états exacte :
 *  - `claimed:<token>` présent → `claim` **directement**, avant tout `status`
 *    (un visiteur qui a déjà son exemplaire ne doit jamais voir « Épuisé ») ;
 *  - sinon `status` → « Prêt à réserver » (aucune consommation), qui sonde
 *    `/status` toutes les 3 s (±25 %) pour basculer vite vers « Épuisé » ;
 *  - le claim n'a lieu qu'au **clic** : les aperçus de liens et les robots ne
 *    consomment aucun exemplaire.
 *
 * Jamais d'erreur brute : une erreur réseau laisse l'écran en l'état avec
 * « Connexion lente, nouvelle tentative… ».
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, hasClaimed, markClaimed, saveVisitorId, visitorIdFor, type VisitorStatus } from '../../lib/api';
import { uuidv4 } from '../../lib/utils';

type Screen = 'loading' | 'reserve' | 'waiting' | 'ready' | 'exhausted' | 'invalid';

const POLL_MIN_MS = 2000;
const POLL_MAX_MS = 8000;
const STATUS_POLL_MS = 3000;

function withJitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function VisitorScreen() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [screen, setScreen] = useState<Screen>('loading');
  const [title, setTitle] = useState<string>('');
  const [status, setStatus] = useState<VisitorStatus | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  const visitorId = useRef<string>('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(false);
  const downloadTriggered = useRef(false);

  const clearTimers = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    timer.current = null;
    statusTimer.current = null;
  }, []);

  /** Interrogation du PDF en préparation (10.2) : base 2 s, ×1,5, plafond 8 s. */
  const pollFile = useCallback(
    async (attempt: number) => {
      let delay = POLL_MIN_MS * 1.5 ** attempt;
      try {
        const result = await api.file(token, visitorId.current);
        setSlow(false);

        if (result.status === 200 && result.body.state === 'ready') {
          setUrl(result.body.url);
          setScreen('ready');
          return;
        }
        if (result.status === 410 || result.body.state === 'exhausted') {
          setScreen('exhausted');
          return;
        }
        if (result.status === 202 && result.body.state === 'waiting') {
          delay = (result.body.retryAfter || 2) * 1000;
        }
      } catch {
        setSlow(true);
      }

      const next = Math.min(POLL_MAX_MS, delay * 1.5);
      timer.current = setTimeout(
        () => void pollFile(attempt + 1),
        withJitter(document.hidden ? 10_000 : next),
      );
    },
    [token],
  );

  /** Claim (au clic, ou immédiat si `claimed` existe déjà). */
  const doClaim = useCallback(async () => {
    clearTimers();
    try {
      const result = await api.claim(token, visitorId.current);
      setSlow(false);

      if (result.status === 200 && result.body.state === 'ready') {
        markClaimed(token);
        setUrl(result.body.url);
        setScreen('ready');
        return;
      }
      if (result.status === 202 && result.body.state === 'waiting') {
        markClaimed(token);
        setScreen('waiting');
        timer.current = setTimeout(
          () => void pollFile(0),
          withJitter((result.body.retryAfter || 2) * 1000),
        );
        return;
      }
      if (result.status === 410) {
        setScreen('exhausted');
        return;
      }
      if (result.status === 404) {
        setScreen('invalid');
        return;
      }
      setSlow(true);
    } catch {
      // Erreur réseau ou 5xx : on ne casse jamais l'écran.
      setSlow(true);
      timer.current = setTimeout(() => void doClaim(), withJitter(POLL_MIN_MS));
    }
  }, [clearTimers, pollFile, token]);

  /** En « Prêt à réserver » : sonde `/status` pour détecter l'épuisement. */
  const pollStatus = useCallback(async () => {
    try {
      const info = await api.linkStatus(token);
      setStatus(info);
      setTitle(info.title);
      if (info.status === 'exhausted') {
        setScreen('exhausted');
        return;
      }
    } catch {
      /* on retente au prochain tour */
    }
    statusTimer.current = setTimeout(() => void pollStatus(), withJitter(STATUS_POLL_MS));
  }, [token]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!token) {
      setScreen('invalid');
      return;
    }

    // 2. `visitorId` propre à ce lien.
    let id = visitorIdFor(token);
    if (!id) {
      id = uuidv4();
      saveVisitorId(token, id);
    }
    visitorId.current = id;

    // 3. Un visiteur qui a déjà réclamé son exemplaire va droit au claim.
    if (hasClaimed(token)) {
      void doClaim();
      return;
    }

    // 4-5. Sinon : `status`, puis « Prêt à réserver » (aucune consommation).
    void (async () => {
      try {
        const info = await api.linkStatus(token);
        setStatus(info);
        setTitle(info.title);
        if (info.status === 'exhausted') {
          setScreen('exhausted');
          return;
        }
        setScreen('reserve');
        statusTimer.current = setTimeout(() => void pollStatus(), withJitter(STATUS_POLL_MS));
      } catch {
        setScreen('invalid');
      }
    })();

    return clearTimers;
  }, [clearTimers, doClaim, pollStatus, token]);

  // Téléchargement automatique en état « Prêt » (section 10.3).
  useEffect(() => {
    if (screen !== 'ready' || !url || downloadTriggered.current) return;
    downloadTriggered.current = true;
    window.location.href = url;
  }, [screen, url]);

  return (
    <main className="page-center">
      <div className="card" style={{ width: 440, maxWidth: '100%', padding: 32, textAlign: 'center' }}>
        <div aria-live="polite">
          {screen === 'loading' && (
            <>
              <div className="spinner" style={{ marginBottom: 16 }} />
              <p className="muted">Chargement…</p>
            </>
          )}

          {screen === 'reserve' && (
            <>
              <h1 style={{ marginBottom: 8 }}>{title}</h1>
              <p className="muted" style={{ marginBottom: 24 }}>
                Téléchargez votre exemplaire au format PDF.
              </p>
              <button type="button" className="btn-primary btn-block" onClick={() => void doClaim()}>
                Télécharger le PDF
              </button>
              {slow && (
                <p className="muted" style={{ marginTop: 12 }}>
                  Connexion lente, nouvelle tentative…
                </p>
              )}
            </>
          )}

          {screen === 'waiting' && (
            <>
              <div className="spinner" style={{ marginBottom: 16 }} />
              <h1 style={{ marginBottom: 8, fontSize: 20 }}>Votre exemplaire est en préparation…</h1>
              <p className="muted">
                Merci de patienter quelques secondes. Cette page se met à jour toute seule.
              </p>
              {slow && (
                <p className="muted" style={{ marginTop: 12 }}>
                  Connexion lente, nouvelle tentative…
                </p>
              )}
            </>
          )}

          {screen === 'ready' && (
            <>
              <div style={{ fontSize: 40, color: 'var(--success)', marginBottom: 8 }} aria-hidden>
                ✓
              </div>
              <h1 style={{ marginBottom: 8, fontSize: 20 }}>
                Votre exemplaire est prêt.
              </h1>
              <p className="muted" style={{ marginBottom: 24 }}>
                Le téléchargement démarre automatiquement.
              </p>
              {url && (
                // `download` reçoit explicitement le titre : sans valeur, et
                // sur la même origine (cas de la production), le navigateur
                // nommerait le fichier d'après le dernier segment de l'URL,
                // c'est-à-dire « v0.pdf ». En développement, l'origine diffère
                // et c'est `Content-Disposition` qui s'applique.
                <a href={url} download={`${title || 'document'}.pdf`}>
                  <button type="button" className="btn-secondary">
                    Si rien ne se passe, cliquez ici
                  </button>
                </a>
              )}
            </>
          )}

          {screen === 'exhausted' && (
            <>
              <h1 style={{ marginBottom: 8, fontSize: 20 }}>Ce lien est épuisé.</h1>
              <p className="muted">Tous les exemplaires ont été distribués.</p>
            </>
          )}

          {screen === 'invalid' && (
            <>
              <h1 style={{ marginBottom: 8, fontSize: 20 }}>
                Ce lien n&#8217;existe pas ou n&#8217;est plus valide.
              </h1>
            </>
          )}
        </div>
      </div>

      <footer
        className="muted"
        style={{ position: 'fixed', bottom: 16, left: 0, right: 0, textAlign: 'center' }}
      >
        Éditeur de documents partagé
      </footer>
    </main>
  );
}

export default function VisitorPage() {
  return (
    <Suspense
      fallback={
        <main className="page-center">
          <p className="muted">Chargement…</p>
        </main>
      }
    >
      <VisitorScreen />
    </Suspense>
  );
}
