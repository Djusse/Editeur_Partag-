'use client';

/**
 * Page de blocage (C4 : 4 refus pour crédit épuisé → blocage jusqu'à la
 * prochaine remise à zéro, à minuit heure de Douala).
 *
 * Pourquoi une page entière et non un simple bandeau : la session reste valide
 * (l'utilisateur peut toujours **lire** les documents, section 9.6), mais toute
 * écriture est refusée. Un bandeau discret se remarque mal, et l'utilisateur ne
 * comprend pas pourquoi sa frappe ne part pas. Cette page explique la cause, le
 * terme et ce qui reste possible.
 *
 * L'unique action est « Changer d'identité » : le blocage porte sur l'adresse
 * e-mail, pas sur le navigateur, et il se lève seul à l'heure indiquée.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, clearSession, loadSession, type Credit, type Session, ApiError } from '../../lib/api';
import { formatDateTime, formatNumber, formatTime } from '../../lib/utils';

/** Compte à rebours lisible : « 2 h 14 min » ou « 47 s ». */
function remainingLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'quelques secondes';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (totalMinutes > 0) return `${totalMinutes} min`;
  return `${Math.floor(ms / 1000)} s`;
}

export default function BlockedPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [credit, setCredit] = useState<Credit | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Force un nouveau rendu pour que le compte à rebours avance.
  const [, setTick] = useState(0);

  const load = useCallback(
    async (current: Session) => {
      setError(null);
      try {
        const info = await api.getCredit(current.token);
        setCredit(info);
        // Le blocage a expiré : plus rien à faire ici.
        if (!info.blockedUntil) router.replace('/documents');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace('/');
          return;
        }
        setError('Impossible de vérifier votre état. Réessayez dans un instant.');
      }
    },
    [router],
  );

  useEffect(() => {
    const current = loadSession();
    if (!current) {
      router.replace('/');
      return;
    }
    setSession(current);
    void load(current);
  }, [load, router]);

  // Le compte à rebours se rafraîchit chaque seconde ; l'état est revérifié
  // chaque minute pour détecter la fin du blocage sans rechargement manuel.
  useEffect(() => {
    const ticker = setInterval(() => setTick((value) => value + 1), 1000);
    const poller = setInterval(() => {
      if (session) void load(session);
    }, 60_000);
    return () => {
      clearInterval(ticker);
      clearInterval(poller);
    };
  }, [load, session]);

  const blockedUntil = credit?.blockedUntil ?? null;
  const expired = blockedUntil ? new Date(blockedUntil).getTime() <= Date.now() : false;

  return (
    <main className="page-center">
      <div className="card" style={{ width: 480, maxWidth: '100%', padding: 32 }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            display: 'grid',
            placeItems: 'center',
            fontSize: 22,
            fontWeight: 600,
            marginBottom: 16,
          }}
          aria-hidden
        >
          !
        </div>

        <h1 style={{ marginBottom: 8 }}>Écriture bloquée</h1>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        {!credit && !error && (
          <>
            <div className="spinner" style={{ marginBottom: 16 }} />
            <p className="muted">Vérification de votre état…</p>
          </>
        )}

        {credit && (
          <>
            <p className="muted" style={{ marginBottom: 20 }}>
              Votre crédit d&#8217;écriture a été refusé <strong>4 fois</strong> dans la
              même journée. L&#8217;écriture est donc suspendue jusqu&#8217;à la prochaine
              remise à zéro, à <strong>minuit heure de Douala</strong>.
            </p>

            <div
              className="banner-danger"
              role="alert"
              style={{ marginBottom: 20, display: 'block' }}
            >
              {blockedUntil ? (
                <>
                  <strong>Blocage levé à {formatTime(blockedUntil)}</strong> ({formatDateTime(blockedUntil)}).
                  <br />
                  Encore <strong>{remainingLabel(blockedUntil)}</strong> à patienter.
                </>
              ) : (
                <>Aucun blocage en cours.</>
              )}
            </div>

            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                rowGap: 8,
                columnGap: 16,
                marginBottom: 24,
                fontSize: 14,
              }}
            >
              <dt className="muted">Écriture bloquée</dt>
              <dd>{expired ? 'terminée' : 'oui'}</dd>
              <dt className="muted">Crédit du jour</dt>
              <dd>
                {formatNumber(credit.remaining)} / {formatNumber(credit.limit)} caractères
              </dd>
              <dt className="muted">Recharge</dt>
              <dd>{formatTime(credit.resetsAt)} (minuit heure de Douala)</dd>
            </dl>

            {/*
              Une seule action : « Changer d'identité ».
              « Continuer en lecture seule » a été retiré : le blocage porte sur
              l'adresse e-mail, donc se connecter avec une autre adresse est la
              seule issue réelle. Continuer en lecture seule ne menait qu'à une
              impasse, l'écriture restant refusée dans tous les documents.
            */}
            <button
              type="button"
              className="btn-primary btn-block"
              onClick={() => {
                clearSession();
                router.replace('/');
              }}
            >
              Changer d&#8217;identité
            </button>

            <p className="muted" style={{ marginTop: 20, fontSize: 13 }}>
              Le blocage se lève tout seul à la remise à zéro indiquée : rien à faire de
              votre côté. Rechargez simplement la page à ce moment-là.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
