'use client';

/**
 * Page visiteur : aucun compte, aucun formulaire.
 *
 * Trois états explicites, jamais d'écran vide (contrainte C5) :
 *   ready      → le PDF est prêt, lien présigné de 60 s
 *   waiting    → génération en cours, on patiente avec un backoff plafonné
 *   exhausted  → le lien a distribué tous ses exemplaires (C6), plus aucun calcul
 *
 * `visitorId` persistant : un rafraîchissement ou un retry renvoie **le même**
 * ticket et ne consomme jamais un second exemplaire (idempotence C1).
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '../../lib/api';
import type { ClaimResponse, LinkStatus } from '../../lib/api';

const VISITOR_KEY = 'editeur.visitorId';

function getVisitorId(): string {
  const existing = window.localStorage.getItem(VISITOR_KEY);
  if (existing) return existing;
  const random = crypto.getRandomValues(new Uint8Array(12));
  const value = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
  window.localStorage.setItem(VISITOR_KEY, value);
  return value;
}

type Screen = 'loading' | 'ready' | 'waiting' | 'exhausted' | 'error';

function VisitorScreen() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [screen, setScreen] = useState<Screen>('loading');
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [claim, setClaim] = useState<ClaimResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(false);

  const poll = useCallback(
    async (visitorId: string, tries: number) => {
      const result = await api.file(token, visitorId);
      if (result.state === 'ready' && result.url) {
        setClaim(result);
        setScreen('ready');
        return;
      }
      if (result.state === 'exhausted') {
        setScreen('exhausted');
        return;
      }
      setClaim(result);
      setScreen('waiting');
      const delay = Math.min(6000, 800 * 1.6 ** tries) + Math.random() * 350;
      timer.current = setTimeout(() => void poll(visitorId, tries + 1), delay);
    },
    [token],
  );

  const claimOnce = useCallback(async () => {
    const visitorId = getVisitorId();
    try {
      const [linkInfo, result] = await Promise.all([api.linkStatus(token), api.claim(token, visitorId)]);
      setStatus(linkInfo);
      setClaim(result);

      if (result.state === 'ready' && result.url) {
        setScreen('ready');
        return;
      }
      if (result.state === 'exhausted') {
        setScreen('exhausted');
        return;
      }
      setScreen('waiting');
      const delay = (result.retryAfter ?? 2) * 1000 + Math.random() * 300;
      timer.current = setTimeout(() => void poll(visitorId, 1), delay);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 410) {
        setScreen('exhausted');
        return;
      }
      setMessage((error as Error).message);
      setScreen('error');
    }
  }, [poll, token]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!token) {
      setMessage('Lien incomplet : le paramètre token est absent.');
      setScreen('error');
      return;
    }
    void claimOnce();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [claimOnce, token]);

  function retry() {
    setAttempt((value) => value + 1);
    setScreen('loading');
    if (timer.current) clearTimeout(timer.current);
    void claimOnce();
  }

  const remaining = claim?.remaining ?? status?.remaining ?? 0;
  const title = status?.docTitle ?? 'Document';

  return (
    <main className="hero">
      <div className="hero-card visitor-state">
        {screen === 'loading' && (
          <>
            <div className="icon">⏳</div>
            <h1 className="title">Préparation…</h1>
            <p className="subtitle">Nous vérifions la disponibilité de votre exemplaire.</p>
          </>
        )}

        {screen === 'ready' && claim?.url && (
          <>
            <div className="icon">📄</div>
            <h1 className="title">{title}</h1>
            <p className="subtitle">Votre exemplaire est prêt. Le lien de téléchargement expire dans 60 secondes.</p>
            <a href={claim.url} target="_blank" rel="noreferrer" download>
              <button className="primary" style={{ marginTop: '1.2rem' }}>
                Télécharger le PDF
              </button>
            </a>
            <p className="muted" style={{ marginTop: '1rem' }}>
              Exemplaires restants après votre réservation : <strong>{remaining}</strong>
            </p>
          </>
        )}

        {screen === 'waiting' && (
          <>
            <div className="icon">⏱️</div>
            <h1 className="title">Patientez un instant</h1>
            <p className="subtitle">
              Le document de votre version est en cours de préparation. Votre exemplaire est réservé, il ne sera pas
              perdu.
            </p>
            <p className="muted">
              Tentative {attempt + 1} · nouvelle vérification dans {claim?.retryAfter ?? 2} s
            </p>
            <button type="button" onClick={() => void poll(getVisitorId(), 1)} style={{ marginTop: '1rem' }}>
              Vérifier maintenant
            </button>
          </>
        )}

        {screen === 'exhausted' && (
          <>
            <div className="icon">🚫</div>
            <h1 className="title">Lien épuisé</h1>
            <p className="subtitle">
              Ce lien a atteint son nombre maximal de téléchargements. Aucun nouvel exemplaire ne peut être délivré.
            </p>
            {status && (
              <p className="muted">
                {status.maxDownloads} exemplaires autorisés, {status.remaining} restants.
              </p>
            )}
          </>
        )}

        {screen === 'error' && (
          <>
            <div className="icon">⚠️</div>
            <h1 className="title">Impossible d'aboutir</h1>
            <p className="subtitle">{message ?? 'Une erreur est survenue.'}</p>
            <button type="button" onClick={retry} style={{ marginTop: '1rem' }}>
              Réessayer
            </button>
          </>
        )}
      </div>
    </main>
  );
}

export default function VisitorPage() {
  return (
    <Suspense fallback={<main className="hero"><div className="hero-card">Chargement…</div></main>}>
      <VisitorScreen />
    </Suspense>
  );
}
