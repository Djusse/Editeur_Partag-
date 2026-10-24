'use client';

/**
 * Administration (section 11).
 *
 * La clé d'administration reste **en mémoire** (jamais dans `localStorage`),
 * rafraîchissement automatique toutes les 10 s, trois blocs :
 * documents ouverts, liens actifs, personnes bloquées.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type AdminState, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';

export default function AdminPage() {
  const [adminKey, setAdminKey] = useState('');
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (key: string) => {
    setLoading(true);
    try {
      const data = await api.adminState(key);
      setState(data);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setError('Clé invalide.');
        setState(null);
      } else {
        setError('Impossible de charger l\'état de l\'application.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Rafraîchissement automatique tant qu'une clé valide est en mémoire.
  useEffect(() => {
    if (!state || !adminKey) return;
    const timer = setInterval(() => void load(adminKey), 10_000);
    return () => clearInterval(timer);
  }, [adminKey, load, state]);

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px 64px' }}>
      <div className="spread" style={{ marginBottom: 24 }}>
        <h1>Administration</h1>
        <div className="row">
          {state && (
            <button type="button" className="btn-secondary" onClick={() => void load(adminKey)} disabled={loading}>
              {loading ? 'Actualisation…' : 'Actualiser'}
            </button>
          )}
          <Link href="/documents" className="btn-ghost" style={{ textDecoration: 'none' }}>
            ← Mes documents
          </Link>
        </div>
      </div>

      {!state && (
        <form
          className="card"
          style={{ padding: 24, maxWidth: 480 }}
          onSubmit={(event) => {
            event.preventDefault();
            void load(adminKey.trim());
          }}
        >
          <label htmlFor="admin-key">Clé d&#8217;administration</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id="admin-key"
              type="password"
              value={adminKey}
              onChange={(event) => {
                setAdminKey(event.target.value);
                setError(null);
              }}
              placeholder="Valeur du paramètre SSM"
              autoComplete="off"
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn-primary" disabled={loading || !adminKey.trim()}>
              Accéder
            </button>
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}

      {state && (
        <div className="stack" style={{ gap: 24 }}>
          {/* 1. Documents ouverts */}
          <section className="card" style={{ overflow: 'hidden' }}>
            <h2 style={{ padding: '20px 24px 0' }}>Documents ouverts</h2>
            {state.openDocuments.length === 0 ? (
              <p className="muted" style={{ padding: '16px 24px 24px' }}>
                Aucun document ouvert.
              </p>
            ) : (
              <table className="table" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>Document</th>
                    <th style={{ textAlign: 'right' }}>Personnes connectées</th>
                  </tr>
                </thead>
                <tbody>
                  {state.openDocuments.map((doc) => (
                    <tr key={doc.docId}>
                      <td>{doc.title}</td>
                      <td style={{ textAlign: 'right' }}>{doc.connections}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* 2. Liens actifs */}
          <section className="card" style={{ overflow: 'hidden' }}>
            <h2 style={{ padding: '20px 24px 0' }}>Liens actifs</h2>
            {state.activeLinks.length === 0 ? (
              <p className="muted" style={{ padding: '16px 24px 24px' }}>
                Aucun lien actif.
              </p>
            ) : (
              <table className="table" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Lien</th>
                    <th style={{ textAlign: 'right' }}>Restants</th>
                  </tr>
                </thead>
                <tbody>
                  {state.activeLinks.map((link) => (
                    <tr key={link.token}>
                      <td>{link.title}</td>
                      <td>
                        <span className="link-token" style={{ display: 'inline' }}>
                          {link.token.slice(0, 8)}…
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {link.remaining} / {link.maxDownloads}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* 3. Personnes bloquées */}
          <section className="card" style={{ overflow: 'hidden' }}>
            <h2 style={{ padding: '20px 24px 0' }}>Personnes bloquées</h2>
            {state.blocked.length === 0 ? (
              <p className="muted" style={{ padding: '16px 24px 24px' }}>
                Aucune personne bloquée.
              </p>
            ) : (
              <table className="table" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>E-mail</th>
                    <th>Bloqué jusqu&#8217;à</th>
                    <th style={{ textAlign: 'right' }}>État</th>
                  </tr>
                </thead>
                <tbody>
                  {state.blocked.map((row) => (
                    <tr key={row.email}>
                      <td>{row.email}</td>
                      <td>{formatDateTime(row.blockedUntil)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="badge badge-blocked">Bloqué</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
