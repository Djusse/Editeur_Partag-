'use client';

/** Liste des documents accessibles, création et crédit du jour. */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, clearSession, getProfile, getToken, ApiError } from '../../lib/api';
import type { CreditInfo, DocumentSummary } from '../../lib/api';

export default function DocumentsPage() {
  const router = useRouter();
  const profile = getProfile();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [credit, setCredit] = useState<CreditInfo | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [docs, cred] = await Promise.all([api.listDocuments(), api.getCredit()]);
      setDocuments(docs.documents);
      setCredit(cred);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace('/');
        return;
      }
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/');
      return;
    }
    void load();
  }, [load, router]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const result = await api.createDocument(title.trim());
      setTitle('');
      router.push(`/doc?id=${encodeURIComponent(result.document.docId)}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const percent = credit ? Math.min(100, Math.round((credit.used / credit.limit) * 100)) : 0;

  return (
    <main className="page">
      <div className="spread" style={{ marginBottom: '1.6rem' }}>
        <div>
          <h1 className="title">Mes documents</h1>
          <p className="subtitle">
            {profile ? `Connecté comme ${profile.name} (${profile.email})` : 'Chargement du profil…'}
          </p>
        </div>
        <div className="row">
          <Link href="/admin">
            <button type="button">Supervision</button>
          </Link>
          <button
            type="button"
            onClick={() => {
              clearSession();
              router.replace('/');
            }}
          >
            Quitter
          </button>
        </div>
      </div>

      <div className="grid two" style={{ marginBottom: '1.6rem' }}>
        <section className="card">
          <div className="spread" style={{ marginBottom: '0.6rem' }}>
            <strong>Crédit du jour</strong>
            <span className={`badge ${credit?.blocked ? 'danger' : percent > 85 ? 'warn' : 'ok'}`}>
              {credit ? `${credit.remaining} restants` : '—'}
            </span>
          </div>
          <div className="credit-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="muted" style={{ margin: '0.6rem 0 0' }}>
            {credit
              ? `${credit.used} / ${credit.limit} caractères utilisés aujourd'hui (recharge à minuit UTC).`
              : 'Calcul en cours…'}
          </p>
          {credit?.blocked && (
            <div className="alert danger" style={{ marginTop: '0.8rem' }}>
              Écriture bloquée après plusieurs refus. Réouverture le {credit.blockedUntil?.slice(0, 16).replace('T', ' ')} UTC.
            </div>
          )}
        </section>

        <section className="card">
          <strong>Nouveau document</strong>
          <form className="row" onSubmit={create} style={{ marginTop: '0.8rem' }}>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Titre du document"
              maxLength={200}
              required
              style={{ flex: 1, minWidth: 180 }}
            />
            <button className="primary" type="submit" disabled={busy || !title.trim()}>
              {busy ? 'Création…' : 'Créer'}
            </button>
          </form>
        </section>
      </div>

      {error && <div className="alert danger" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <p className="muted">Chargement…</p>
      ) : documents.length === 0 ? (
        <div className="card">
          <p style={{ margin: 0 }}>Aucun document pour l'instant. Créez le premier ci-dessus.</p>
        </div>
      ) : (
        <div className="list">
          {documents.map((doc) => (
            <Link key={doc.docId} href={`/doc?id=${encodeURIComponent(doc.docId)}`} style={{ color: 'inherit' }}>
              <div className="list-item">
                <div>
                  <strong>{doc.title}</strong>
                  <div className="muted">
                    {doc.textLength} caractères · {doc.seq} modifications · {doc.role === 'owner' ? 'propriétaire' : 'éditeur'}
                  </div>
                </div>
                <span className="badge">ouvrir</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
