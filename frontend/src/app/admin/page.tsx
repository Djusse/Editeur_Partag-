'use client';

/**
 * Supervision : documents ouverts, liens actifs et restants, personnes bloquées.
 * Protégée par la clé admin (en-tête X-Admin-Key), stockée dans SSM.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../lib/api';
import type { AdminState } from '../../lib/api';

const KEY_STORAGE = 'editeur.adminKey';

export default function AdminPage() {
  const [adminKey, setAdminKey] = useState('');
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (key: string) => {
      setLoading(true);
      try {
        const data = await api.adminState(key);
        setState(data);
        setError(null);
        window.localStorage.setItem(KEY_STORAGE, key);
      } catch (err) {
        setError((err as Error).message);
        setState(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const saved = window.localStorage.getItem(KEY_STORAGE);
    if (saved) {
      setAdminKey(saved);
      void load(saved);
    }
  }, [load]);

  useEffect(() => {
    if (!state) return;
    const timer = setInterval(() => void load(adminKey), 10000);
    return () => clearInterval(timer);
  }, [adminKey, load, state]);

  return (
    <main className="page">
      <div className="spread" style={{ marginBottom: '1.4rem' }}>
        <div>
          <h1 className="title">Supervision</h1>
          <p className="subtitle">État de l'application, actualisé toutes les 10 secondes.</p>
        </div>
        <Link href="/documents" className="muted">
          ← Mes documents
        </Link>
      </div>

      <section className="card" style={{ marginBottom: '1.2rem' }}>
        <label htmlFor="adminKey">{'Clé d\'administration (SSM : /<stack>/admin-key)'}</label>
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            void load(adminKey.trim());
          }}
        >
          <input
            id="adminKey"
            type="password"
            value={adminKey}
            onChange={(event) => setAdminKey(event.target.value)}
            placeholder="Valeur du paramètre SSM"
            style={{ flex: 1, minWidth: 220 }}
          />
          <button className="primary" type="submit" disabled={loading || !adminKey.trim()}>
            {loading ? 'Chargement…' : 'Charger'}
          </button>
        </form>
        {error && <div className="alert danger" style={{ marginTop: '0.8rem' }}>{error}</div>}
      </section>

      {state && (
        <>
          <div className="grid two" style={{ marginBottom: '1.2rem' }}>
            <div className="card">
              <div className="muted">Documents</div>
              <div style={{ fontSize: '2rem', fontWeight: 700 }}>{state.totals.documents}</div>
            </div>
            <div className="card">
              <div className="muted">Documents ouverts</div>
              <div style={{ fontSize: '2rem', fontWeight: 700 }}>{state.totals.openDocuments}</div>
            </div>
            <div className="card">
              <div className="muted">Connexions temps réel</div>
              <div style={{ fontSize: '2rem', fontWeight: 700 }}>{state.totals.connections}</div>
            </div>
            <div className="card">
              <div className="muted">Liens actifs</div>
              <div style={{ fontSize: '2rem', fontWeight: 700 }}>{state.activeLinks}</div>
            </div>
          </div>

          <section className="card" style={{ marginBottom: '1.2rem' }}>
            <strong>Documents ouverts</strong>
            <div className="list" style={{ marginTop: '0.8rem' }}>
              {state.openDocuments.length === 0 && <p className="muted">Aucun document ouvert en ce moment.</p>}
              {state.openDocuments.map((doc) => (
                <div key={doc.docId} className="list-item">
                  <div>
                    <strong>{doc.title}</strong>
                    <div className="muted">
                      {doc.readers} connexion(s) · séquence {doc.seq}
                    </div>
                    {doc.links.length > 0 && (
                      <div className="muted" style={{ marginTop: '0.35rem' }}>
                        {doc.links.map((link) => (
                          <span key={link.token} style={{ marginRight: '0.8rem' }}>
                            {link.remaining}/{link.maxDownloads} {link.status === 'ACTIVE' ? '' : '(épuisé)'}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <Link href={`/doc?id=${encodeURIComponent(doc.docId)}`}>
                    <button type="button">Ouvrir</button>
                  </Link>
                </div>
              ))}
            </div>
          </section>

          <div className="grid two">
            <section className="card">
              <strong>Crédit du jour</strong>
              <div className="list scroll-y" style={{ marginTop: '0.8rem' }}>
                {state.creditToday.length === 0 && <p className="muted">Aucun crédit consommé aujourd'hui.</p>}
                {state.creditToday.map((row) => (
                  <div key={row.email} className="list-item">
                    <span>{row.email}</span>
                    <span className="muted">
                      {row.used} / {row.limit}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="card">
              <strong>Personnes bloquées</strong>
              <div className="list scroll-y" style={{ marginTop: '0.8rem' }}>
                {state.blocked.length === 0 && <p className="muted">Personne n'est bloqué.</p>}
                {state.blocked.map((row) => (
                  <div key={row.email} className="list-item">
                    <div>
                      <strong>{row.email}</strong>
                      <div className="muted">{row.refusals} refus</div>
                    </div>
                    <span className="badge danger">{row.blockedUntil.slice(0, 16).replace('T', ' ')} UTC</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
