'use client';

/** Mes documents (section 8) : liste, création par modale, états de chargement. */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import TopBar from '../../components/TopBar';
import Modal from '../../components/Modal';
import Toasts, { type Toast } from '../../components/Toasts';
import {
  api,
  clearSession,
  loadSession,
  type Credit,
  type DocumentSummary,
  type Session,
  ApiError,
} from '../../lib/api';
import { formatRelative, uuidv4 } from '../../lib/utils';

export default function DocumentsPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [credit, setCredit] = useState<Credit | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((message: string, variant: Toast['variant']) => {
    setToasts((current) => [...current, { id: uuidv4(), message, variant }]);
  }, []);

  const load = useCallback(
    async (current: Session) => {
      setError(null);
      try {
        const [list, creditInfo] = await Promise.all([
          api.listDocuments(current.token),
          api.getCredit(current.token),
        ]);
        setDocuments(list.documents);
        setCredit(creditInfo);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          router.replace('/');
          return;
        }
        setError('Impossible de charger vos documents.');
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

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed.length < 1 || trimmed.length > 120) {
      setTitleError('Donnez un titre au document.');
      return;
    }
    if (!session) return;

    setBusy(true);
    try {
      const result = await api.createDocument(session.token, trimmed);
      router.push(`/doc?id=${encodeURIComponent(result.id)}`);
    } catch (err) {
      pushToast(err instanceof ApiError ? err.message : 'Création impossible.', 'error');
    } finally {
      setBusy(false);
    }
  }

  const loading = documents === null && !error;

  return (
    <>
      <TopBar session={session} credit={credit} />

      <main style={{ maxWidth: 880, margin: '0 auto', padding: '32px 24px 64px' }}>
        <div className="spread" style={{ marginBottom: 24 }}>
          <h1>Mes documents</h1>
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            + Nouveau document
          </button>
        </div>

        {loading && (
          <div className="list-card" style={{ padding: 20 }}>
            {[0, 1, 2].map((index) => (
              <div key={index} style={{ padding: '16px 0' }}>
                <div className="skeleton" style={{ width: '40%', marginBottom: 8 }} />
                <div className="skeleton" style={{ width: '25%', height: 10 }} />
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="card" style={{ padding: 24, textAlign: 'center' }}>
            <p style={{ marginBottom: 16 }}>{error}</p>
            <button type="button" className="btn-secondary" onClick={() => session && load(session)}>
              Réessayer
            </button>
          </div>
        )}

        {documents && documents.length === 0 && (
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>
            <p style={{ marginBottom: 16 }}>Aucun document pour l&#8217;instant.</p>
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              Créer le premier document
            </button>
          </div>
        )}

        {documents && documents.length > 0 && (
          <div className="list-card">
            {documents.map((doc) => (
              <button
                key={doc.id}
                type="button"
                className="list-row"
                onClick={() => router.push(`/doc?id=${encodeURIComponent(doc.id)}`)}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 500, marginBottom: 2 }}>{doc.title}</span>
                  <span className="muted">
                    {doc.role === 'owner' ? 'Propriétaire : moi' : `Partagé par ${doc.ownerName}`}
                  </span>
                </span>
                <span className="muted" style={{ whiteSpace: 'nowrap' }}>
                  Modifié {formatRelative(doc.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        )}
      </main>

      {creating && (
        <Modal title="Nouveau document" onClose={() => setCreating(false)}>
          <form onSubmit={create} className="stack">
            <div>
              <label htmlFor="title">Titre</label>
              <input
                id="title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setTitleError(null);
                }}
                maxLength={120}
                autoFocus
                aria-invalid={Boolean(titleError)}
                aria-describedby={titleError ? 'title-error' : undefined}
              />
              {titleError && (
                <p className="field-error" id="title-error" role="alert">
                  {titleError}
                </p>
              )}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
                Annuler
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? 'Création…' : 'Créer'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      <Toasts toasts={toasts} onDismiss={(id) => setToasts((list) => list.filter((item) => item.id !== id))} />
    </>
  );
}
