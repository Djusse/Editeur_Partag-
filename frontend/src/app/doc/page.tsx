'use client';

/**
 * Éditeur (section 9).
 *
 * Ordre de chargement imposé (9.2) :
 *   1. `id` dans l'URL ;
 *   2. `GET /documents/{id}` (403 → accès refusé, 404 → introuvable) ;
 *   3. `GET /documents/{id}/state` → état Yjs complet ;
 *   4. rejeu **local** de `pendingOps` (Y.applyUpdate est idempotent) ;
 *   5. affichage CodeMirror ;
 *   6. ticket + WebSocket + `join {sinceSeq}` ;
 *   7. renvoi des `pendingOps` avec leur `opId` d'origine.
 *
 * Rejet (9.5) : reconstitution du document depuis le serveur, lecture seule
 * selon le code, message « Vos dernières modifications n'ont pas été enregistrées ».
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import NextLink from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as Y from 'yjs';
import { EditorView, placeholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { yCollab } from 'y-codemirror.next';
import TopBar from '../../components/TopBar';
import Modal from '../../components/Modal';
import Toasts, { type Toast } from '../../components/Toasts';
import {
  api,
  clearPendingOps,
  clearSession,
  loadPendingOps,
  loadSession,
  type Credit,
  type DocumentDetail,
  type Link as ShareLink,
  type Session,
  type Version,
  ApiError,
} from '../../lib/api';
import { CollaborativeProvider, type ConnectionState, type Peer } from '../../lib/provider';
import { editableCompartment, setReadOnly } from '../../lib/editor';
import {
  colorFor,
  copyText,
  formatDateTime,
  formatTime,
  initialOf,
  isValidEmail,
  linkUrl,
  uuidv4,
} from '../../lib/utils';

type Overlay = 'none' | 'share' | 'versions' | 'links';
type LoadError = 'forbidden' | 'notfound' | 'generic' | null;

function EditorScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const docId = params.get('id') ?? '';

  const [session, setSession] = useState<Session | null>(null);
  const [credit, setCredit] = useState<Credit | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [loadError, setLoadError] = useState<LoadError>(null);
  const [loading, setLoading] = useState(true);

  const [connection, setConnection] = useState<ConnectionState>('offline');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [queueSize, setQueueSize] = useState(0);
  const [readOnlyReason, setReadOnlyReason] = useState<'credit' | 'blocked' | 'forbidden' | null>(null);
  const [blockedUntil, setBlockedUntil] = useState<string | null>(null);

  const [overlay, setOverlay] = useState<Overlay>('none');
  const [toasts, setToasts] = useState<Toast[]>([]);

  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const provider = useRef<CollaborativeProvider | null>(null);
  const ydoc = useRef<Y.Doc | null>(null);

  const pushToast = useCallback((message: string, variant: Toast['variant']) => {
    setToasts((current) => [...current, { id: uuidv4(), message, variant }]);
  }, []);

  const refreshCredit = useCallback(async (current: Session) => {
    try {
      const info = await api.getCredit(current.token);
      setCredit(info);
      if (info.blockedUntil) {
        setBlockedUntil(info.blockedUntil);
        setReadOnlyReason('blocked');
      } else if (info.remaining <= 0) {
        setReadOnlyReason('credit');
      }
    } catch {
      /* la jauge sera rafraîchie au prochain ack */
    }
  }, []);

  /** Reconstruit le document depuis le serveur (procédure de rejet, 9.5). */
  const rebuildFromServer = useCallback(
    async (current: Session) => {
      const state = await api.getState(current.token, docId);
      const fresh = new Y.Doc();
      Y.applyUpdate(fresh, Uint8Array.from(atob(state.state), (char) => char.charCodeAt(0)));

      provider.current?.destroy();
      provider.current = null;
      view.current?.destroy();
      view.current = null;
      ydoc.current?.destroy();

      ydoc.current = fresh;
      mountEditor(fresh, true);
      await startProvider(current, fresh, state.seq, true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docId],
  );

  // --- Montage de l'éditeur -----------------------------------------------
  const mountEditor = (doc: Y.Doc, readOnly: boolean) => {
    if (!host.current) return;
    const ytext = doc.getText('content');

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        EditorView.lineWrapping,
        placeholder('Commencez à écrire…'),
        editableCompartment.of(EditorView.editable.of(!readOnly)),
        yCollab(ytext, null),
      ],
    });

    view.current = new EditorView({ state, parent: host.current });
  };

  const startProvider = async (
    current: Session,
    doc: Y.Doc,
    sinceSeq: number,
    rebuild: boolean,
  ) => {
    const instance = new CollaborativeProvider(doc, {
      documentId: docId,
      email: current.email,
      token: current.token,
      getTicket: async () => {
        const ticket = await api.wsTicket(current.token, docId);
        return ticket.ticket;
      },
      callbacks: {
        onState: setConnection,
        onPresence: setPeers,
        onQueueChange: setQueueSize,
        onAck: ({ creditRemaining }) => {
          setCredit((previous) =>
            previous ? { ...previous, remaining: creditRemaining, used: previous.limit - creditRemaining } : previous,
          );
        },
        onRejection: (payload) => {
          if (payload.code === 'CREDIT_EXHAUSTED') {
            setReadOnlyReason('credit');
            pushToast('Vos dernières modifications n\'ont pas été enregistrées.', 'error');
          } else if (payload.code === 'BLOCKED') {
            setReadOnlyReason('blocked');
            if (payload.blockedUntil) setBlockedUntil(payload.blockedUntil);
            pushToast('Vos dernières modifications n\'ont pas été enregistrées.', 'error');
          } else if (payload.code === 'FORBIDDEN') {
            setReadOnlyReason('forbidden');
            pushToast('Vous n\'avez plus accès à ce document.', 'error');
          } else {
            pushToast(
              'Cette modification est trop volumineuse et n\'a pas été enregistrée.',
              'error',
            );
          }
          void rebuildFromServer(current);
        },
      },
    });

    if (!rebuild) instance.loadPending(loadPendingOps(docId, current.email));
    provider.current = instance;
    await instance.connect(sinceSeq);
  };

  // --- Chargement initial --------------------------------------------------
  useEffect(() => {
    const current = loadSession();
    if (!current) {
      router.replace('/');
      return;
    }
    setSession(current);

    if (!docId) {
      setLoadError('notfound');
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // 2. Détail du document (403/404 explicites).
        const docDetail = await api.getDocument(current.token, docId);
        if (cancelled) return;
        setDetail(docDetail);
        void refreshCredit(current);

        // 3. État Yjs complet.
        const state = await api.getState(current.token, docId);
        if (cancelled) return;

        const doc = new Y.Doc();
        Y.applyUpdate(doc, Uint8Array.from(atob(state.state), (char) => char.charCodeAt(0)));
        ydoc.current = doc;

        // 4. Rejeu local des updates non acquittées.
        const pending = loadPendingOps(docId, current.email);
        for (const op of pending) {
          try {
            Y.applyUpdate(doc, Uint8Array.from(atob(op.update), (char) => char.charCodeAt(0)));
          } catch {
            /* update illisible : il sera abandonné à l'envoi */
          }
        }

        // 5. Affichage.
        mountEditor(doc, false);
        setLoading(false);

        // 6-7. WebSocket + join + renvoi.
        await startProvider(current, doc, state.seq, false);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError) {
          if (error.status === 401) {
            clearSession();
            router.replace('/');
            return;
          }
          if (error.status === 403) setLoadError('forbidden');
          else if (error.status === 404) setLoadError('notfound');
          else setLoadError('generic');
        } else {
          setLoadError('generic');
        }
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      provider.current?.destroy();
      provider.current = null;
      view.current?.destroy();
      view.current = null;
      ydoc.current?.destroy();
      ydoc.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, router]);

  // --- Lecture seule -------------------------------------------------------
  useEffect(() => {
    setReadOnly(view.current, readOnlyReason !== null);
  }, [readOnlyReason]);

  // --- Rendu ---------------------------------------------------------------
  if (loadError === 'forbidden' || loadError === 'notfound') {
    return (
      <>
        <TopBar session={session} credit={credit} />
        <main className="page-center" style={{ minHeight: 'calc(100vh - 56px)' }}>
          <div className="card" style={{ padding: 32, textAlign: 'center', maxWidth: 420 }}>
            <p style={{ marginBottom: 16 }}>
              {loadError === 'forbidden'
                ? 'Vous n\'avez pas accès à ce document.'
                : 'Document introuvable.'}
            </p>
            <NextLink href="/documents">
              <button type="button" className="btn-secondary">
                ← Mes documents
              </button>
            </NextLink>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar session={session} credit={credit} />

      {connection === 'reconnecting' && (
        <div className="banner banner-warning" role="status">
          Reconnexion…
        </div>
      )}
      {connection === 'offline' && (
        <div className="banner banner-warning" role="status">
          Hors ligne — vos modifications sont conservées et seront envoyées au retour du réseau
        </div>
      )}

      {/* Barre d'outils */}
      <div
        style={{
          height: 56,
          background: 'var(--bg)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '0 24px',
        }}
      >
        <div className="row" style={{ gap: 16, minWidth: 0 }}>
          <NextLink href="/documents" className="btn-ghost" style={{ textDecoration: 'none' }}>
            ← Mes documents
          </NextLink>
          <span style={{ fontSize: 18, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {detail?.title ?? (loading ? '' : 'Document')}
          </span>
        </div>

        <div className="row" style={{ gap: 12 }}>
          <span className="row" style={{ gap: 6 }}>
            <span
              className="dot"
              style={{ background: connection === 'connected' ? 'var(--success)' : 'var(--warning)' }}
            />
            <span className="muted">{connection === 'connected' ? 'Connecté' : 'Reconnexion…'}</span>
          </span>
          <button type="button" className="btn-secondary" onClick={() => setOverlay('share')}>
            Partager
          </button>
          <button type="button" className="btn-secondary" onClick={() => setOverlay('versions')}>
            Versions
          </button>
          <button type="button" className="btn-secondary" onClick={() => setOverlay('links')}>
            Liens de téléchargement
          </button>
        </div>
      </div>

      {/* Bandeau de lecture seule */}
      {readOnlyReason === 'credit' && credit && (
        <div style={{ padding: '0 24px', marginTop: 12 }}>
          <div className="banner-danger" role="alert">
            <strong>Crédit du jour épuisé.</strong> Vous pourrez de nouveau écrire à{' '}
            {formatTime(credit.resetsAt)}.
          </div>
        </div>
      )}
      {readOnlyReason === 'blocked' && (
        <div style={{ padding: '0 24px', marginTop: 12 }}>
          <div className="banner-danger" role="alert">
            <strong>Écriture bloquée</strong>
            {blockedUntil ? ` jusqu'à ${formatTime(blockedUntil)}` : ''}. Vous pouvez toujours lire ce document.
          </div>
        </div>
      )}
      {readOnlyReason === 'forbidden' && (
        <div style={{ padding: '0 24px', marginTop: 12 }}>
          <div className="banner-danger" role="alert">
            Vous n&#8217;avez plus accès à ce document.
          </div>
        </div>
      )}

      {queueSize > 0 && (
        <div className="banner banner-warning" role="status" aria-live="polite">
          {queueSize} modification{queueSize > 1 ? 's' : ''} en attente d&#8217;enregistrement…
        </div>
      )}

      {/* Corps */}
      <div className="editor-shell">
        <div className="editor-zone">
          <div className="paper">
            {loading ? (
              <div className="stack">
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} className="skeleton" style={{ width: `${90 - index * 12}%` }} />
                ))}
              </div>
            ) : (
              <div ref={host} />
            )}
          </div>
        </div>

        <aside className="presence-panel">
          <h2 style={{ marginBottom: 16 }}>Présents ({peers.length})</h2>
          {peers.length === 0 && <p className="muted">Personne d&#8217;autre pour l&#8217;instant.</p>}
          {peers.map((peer) => {
            const isMe = peer.email === session?.email;
            return (
              <div key={peer.email} className="presence-row">
                <span className="avatar" style={{ background: colorFor(peer.email) }}>
                  {initialOf(peer.name, peer.email)}
                </span>
                <span className="small">
                  {peer.name}
                  {isMe && <span className="muted"> (vous)</span>}
                </span>
              </div>
            );
          })}
        </aside>
      </div>

      {overlay === 'share' && session && (
        <ShareModal
          session={session}
          document={detail}
          onClose={() => setOverlay('none')}
          onUpdated={setDetail}
          onToast={pushToast}
        />
      )}

      {overlay === 'versions' && session && (
        <VersionsModal
          session={session}
          documentId={docId}
          title={detail?.title ?? ''}
          onClose={() => setOverlay('none')}
          onToast={pushToast}
        />
      )}

      {overlay === 'links' && session && (
        <LinksModal
          session={session}
          documentId={docId}
          onClose={() => setOverlay('none')}
          onToast={pushToast}
        />
      )}

      <Toasts toasts={toasts} onDismiss={(id) => setToasts((list) => list.filter((item) => item.id !== id))} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Modale « Partager » (9.8)
// ---------------------------------------------------------------------------
function ShareModal({
  session,
  document,
  onClose,
  onUpdated,
  onToast,
}: {
  session: Session;
  document: DocumentDetail | null;
  onClose: () => void;
  onUpdated: (doc: DocumentDetail) => void;
  onToast: (message: string, variant: Toast['variant']) => void;
}) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState(document?.members ?? []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!isValidEmail(value)) {
      setError('Adresse e-mail invalide.');
      return;
    }

    setBusy(true);
    try {
      const result = await api.addMember(session.token, document?.id ?? '', value);
      setMembers(result.members);
      if (document) onUpdated({ ...document, members: result.members });
      setEmail('');
      setError(null);
      onToast(`${value} ajouté.`, 'success');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_MEMBER') {
        setError('Cette personne a déjà accès.');
      } else {
        onToast('Impossible d\'ajouter cette personne. Réessayez.', 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Partager « ${document?.title ?? ''} »`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div>
          <label htmlFor="member-email">Ajouter un rédacteur</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id="member-email"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
              placeholder="collegue@exemple.com"
              aria-invalid={Boolean(error)}
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn-primary" disabled={busy}>
              Ajouter
            </button>
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <hr className="divider" />

        <div>
          <h2 style={{ marginBottom: 12 }}>Membres</h2>
          <div className="stack" style={{ gap: 8 }}>
            {members.map((member) => (
              <div key={member.email} className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small">
                  {member.name} <span className="muted">({member.email})</span>
                </span>
                {member.role === 'owner' && <span className="muted">Propriétaire</span>}
              </div>
            ))}
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Modale « Versions » (9.9)
// ---------------------------------------------------------------------------
function VersionsModal({
  session,
  documentId,
  title,
  onClose,
  onToast,
}: {
  session: Session;
  documentId: string;
  title: string;
  onClose: () => void;
  onToast: (message: string, variant: Toast['variant']) => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.listVersions(session.token, documentId);
        setVersions(result.versions);
      } catch {
        setVersions([]);
      }
    })();
  }, [documentId, session.token]);

  async function restore(n: number) {
    setBusy(true);
    try {
      await api.restoreVersion(session.token, documentId, n);
      onToast(`Version ${n} restaurée.`, 'success');
      onClose();
    } catch {
      onToast('Restauration impossible.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Versions de « ${title} »`} onClose={onClose}>
      {versions === null && <p className="muted">Chargement…</p>}

      {versions && versions.length === 0 && (
        <p className="muted">Aucune version enregistrée pour l&#8217;instant.</p>
      )}

      {versions && versions.length > 0 && (
        <div className="stack" style={{ gap: 12 }}>
          {versions.map((version) => (
            <div key={version.n} className="spread" style={{ alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 500 }}>Version {version.n}</div>
                <div className="muted">
                  {formatDateTime(version.createdAt)} — {version.authorName}
                </div>
              </div>
              {confirming === version.n ? (
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn-secondary" onClick={() => setConfirming(null)}>
                    Annuler
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy}
                    onClick={() => void restore(version.n)}
                  >
                    Restaurer
                  </button>
                </div>
              ) : (
                <button type="button" className="btn-secondary" onClick={() => setConfirming(version.n)}>
                  Restaurer
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {confirming !== null && (
        <p className="banner-info" style={{ marginTop: 16 }}>
          Remplacer le texte actuel par la version {confirming} ? Le texte actuel reste dans
          l&#8217;historique.
        </p>
      )}

      <p className="muted" style={{ marginTop: 16 }}>
        Une version est enregistrée automatiquement pendant l&#8217;écriture.
      </p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Modale « Liens de téléchargement » (9.10)
// ---------------------------------------------------------------------------
function LinksModal({
  session,
  documentId,
  onClose,
  onToast,
}: {
  session: Session;
  documentId: string;
  onClose: () => void;
  onToast: (message: string, variant: Toast['variant']) => void;
}) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [maxDownloads, setMaxDownloads] = useState('500');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listLinks(session.token, documentId);
      setLinks(result.links);
    } catch {
      setLinks([]);
    }
  }, [documentId, session.token]);

  useEffect(() => {
    void refresh();
    // Rafraîchissement du nombre restant toutes les 5 s tant que la modale est ouverte.
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const value = Number(maxDownloads);
    if (!Number.isInteger(value) || value < 1 || value > 100_000) {
      setError('Entrez un nombre entier entre 1 et 100 000.');
      return;
    }

    setBusy(true);
    try {
      await api.createLink(session.token, documentId, value);
      await refresh();
      setError(null);
      onToast('Lien créé.', 'success');
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Création impossible.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function copy(token: string) {
    const ok = copyText(linkUrl(token));
    if (ok) {
      setCopied(token);
      setCopyFailed(null);
      setTimeout(() => setCopied(null), 2000);
    } else {
      setCopyFailed(token);
      onToast('Sélectionnez et copiez manuellement', 'error');
    }
  }

  return (
    <Modal title="Liens de téléchargement" onClose={onClose}>
      <form className="stack" onSubmit={create}>
        <div>
          <label htmlFor="max-downloads">Nombre de téléchargements autorisés</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id="max-downloads"
              type="number"
              min={1}
              max={100000}
              value={maxDownloads}
              onChange={(event) => {
                setMaxDownloads(event.target.value);
                setError(null);
              }}
              aria-invalid={Boolean(error)}
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn-primary" disabled={busy}>
              Créer le lien
            </button>
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </form>

      <hr className="divider" />

      {links === null && <p className="muted">Chargement…</p>}
      {links && links.length === 0 && <p className="muted">Aucun lien pour ce document.</p>}

      {links && links.length > 0 && (
        <div className="stack" style={{ gap: 12 }}>
          {links.map((link) => (
            <div
              key={link.token}
              style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 12 }}
            >
              <div className="spread" style={{ gap: 8, marginBottom: 8 }}>
                <span className="link-token" title={linkUrl(link.token)}>
                  {linkUrl(link.token)}
                </span>
                <button type="button" className="btn-secondary" onClick={() => copy(link.token)}>
                  {copied === link.token ? 'Copié ✓' : 'Copier'}
                </button>
              </div>
              {copyFailed === link.token && (
                <p className="field-error" style={{ marginBottom: 8 }}>
                  Sélectionnez et copiez manuellement
                </p>
              )}
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="small">
                  Restants : <strong>{link.remaining} / {link.maxDownloads}</strong>
                </span>
                <span className={`badge ${link.status === 'ACTIVE' ? 'badge-active' : 'badge-exhausted'}`}>
                  {link.status === 'ACTIVE' ? 'Actif' : 'Épuisé'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="muted" style={{ marginTop: 16 }}>
        Le lien fournit la version du document au moment où le visiteur demande le téléchargement.
        Vous serez prévenu par e-mail quand le dernier exemplaire sera distribué.
      </p>
    </Modal>
  );
}

export default function DocPage() {
  return (
    <Suspense
      fallback={
        <main className="page-center">
          <p className="muted">Chargement…</p>
        </main>
      }
    >
      <EditorScreen />
    </Suspense>
  );
}
