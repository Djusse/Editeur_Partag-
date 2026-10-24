'use client';

/**
 * Éditeur collaboratif.
 * Route par query string (/doc?id=…) car l'export statique ne connaît pas les
 * identifiants à l'avance. Le document est reconstruit depuis le journal
 * (snapshot + updates) puis maintenu à jour par le provider WebSocket.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as Y from 'yjs';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { yCollab } from 'y-codemirror.next';
import { api, getToken, wsUrl, apiBase, getProfile, ApiError } from '../../lib/api';
import type { CreditInfo, DocumentDetail, LinkSummary, VersionSummary } from '../../lib/api';
import { YjsWebSocketProvider, fromBase64, type ProviderStatus, type RemotePeer } from '../../lib/provider';
import { editableCompartment, readOnlyEffect } from '../../lib/editor';

const STATUS_LABEL: Record<ProviderStatus, { text: string; tone: string }> = {
  connecting: { text: 'Connexion…', tone: 'warn' },
  connected: { text: 'Temps réel actif', tone: 'ok' },
  reconnecting: { text: 'Reconnexion…', tone: 'warn' },
  fallback: { text: 'Mode repli HTTP', tone: 'warn' },
  closed: { text: 'Déconnecté', tone: 'danger' },
};

function EditorScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const docId = params.get('id') ?? '';
  const profile = getProfile();

  const editorHost = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const providerRef = useRef<YjsWebSocketProvider | null>(null);
  const docRef = useRef<Y.Doc | null>(null);

  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [credit, setCredit] = useState<CreditInfo | null>(null);
  const [status, setStatus] = useState<ProviderStatus>('connecting');
  const [peers, setPeers] = useState<RemotePeer[]>([]);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [maxDownloads, setMaxDownloads] = useState(500);
  const [newMember, setNewMember] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState(0);

  const refreshCredit = useCallback(async () => {
    try {
      const info = await api.getCredit();
      setCredit(info);
      if (info.blocked) {
        setBlocked(info.blockedUntil ?? 'bientôt');
        providerRef.current?.setReadOnly(true);
        if (viewRef.current) readOnlyEffect(viewRef.current, true);
      }
    } catch {
      /* le crédit se rafraîchit au prochain tour */
    }
  }, []);

  // Chargement initial : document, versions, crédit, puis contenu CRDT.
  useEffect(() => {
    if (!getToken()) {
      router.replace('/');
      return;
    }
    if (!docId) {
      setError('Identifiant de document manquant.');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const [docDetail, versionList, creditInfo, state] = await Promise.all([
          api.getDocument(docId),
          api.listVersions(docId),
          api.getCredit(),
          api.getState(docId),
        ]);
        if (cancelled) return;
        setDetail(docDetail);
        setVersions(versionList.versions);
        setCredit(creditInfo);
        setSeq(state.seq);
        if (creditInfo.blocked) setBlocked(creditInfo.blockedUntil ?? 'bientôt');

        const ydoc = new Y.Doc();
        docRef.current = ydoc;
        if (state.snapshot) {
          Y.applyUpdate(ydoc, fromBase64(state.snapshot), 'remote');
        }
        for (const update of state.updates) {
          Y.applyUpdate(ydoc, fromBase64(update.payload), 'remote');
        }

        mountEditor(ydoc);
        startProvider(ydoc);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace('/');
          return;
        }
        setError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      providerRef.current?.destroy();
      providerRef.current = null;
      viewRef.current?.destroy();
      viewRef.current = null;
      docRef.current?.destroy();
      docRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, router]);

  function mountEditor(ydoc: Y.Doc) {
    if (!editorHost.current) return;
    const ytext = ydoc.getText('content');
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.theme({
          '&': { backgroundColor: 'transparent', color: '#eef2ff' },
          '.cm-activeLine': { backgroundColor: 'rgba(109,139,255,0.07)' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
            backgroundColor: 'rgba(109,139,255,0.24)',
          },
        }),
        yCollab(ytext, null),
        editableCompartment.of(EditorView.editable.of(true)),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          providerRef.current?.sendAwareness(update.state.selection.main.head);
        }),
      ],
    });
    viewRef.current = new EditorView({ state, parent: editorHost.current });
    if (blocked) readOnlyEffect(viewRef.current, true);
  }

  function startProvider(ydoc: Y.Doc) {
    const token = getToken();
    if (!token) return;
    const provider = new YjsWebSocketProvider(ydoc, {
      docId,
      wsBase: wsUrl(),
      apiBase: apiBase(),
      token,
      batchMs: 300,
      events: {
        onStatus: setStatus,
        onPeers: setPeers,
        onAck: (ackedSeq) => {
          setSeq(ackedSeq);
          void refreshCredit();
        },
        onCreditError: (payload) => {
          setBlocked(payload.blockedUntil ?? null);
          provider.setReadOnly(true);
          if (viewRef.current) readOnlyEffect(viewRef.current, true);
          setError(payload.message);
          void refreshCredit();
        },
        onError: (message) => setError(message),
      },
    });
    providerRef.current = provider;
  }

  async function createLink() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.createLink(docId, maxDownloads);
      const url = `${window.location.origin}/d?token=${result.link.token}`;
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      setNotice(`Lien créé (${result.link.maxDownloads} exemplaires) et copié : ${url}`);
      const refreshed = await api.getDocument(docId);
      setDetail(refreshed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function share(event: React.FormEvent) {
    event.preventDefault();
    if (!newMember.trim()) return;
    setBusy(true);
    try {
      await api.addMember(docId, newMember.trim().toLowerCase(), newMember.split('@')[0]);
      setNewMember('');
      setDetail(await api.getDocument(docId));
      setNotice('Rédacteur ajouté.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveVersion() {
    setBusy(true);
    try {
      await api.createVersion(docId);
      const list = await api.listVersions(docId);
      setVersions(list.versions);
      setNotice('Version enregistrée.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore(n: number) {
    setBusy(true);
    try {
      const result = await api.restoreVersion(docId, n);
      setSeq(result.seq);
      setNotice(`Version ${n} restaurée (nouvel update, historique conservé).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const statusInfo = STATUS_LABEL[status];
  const others = useMemo(() => peers.filter((peer) => peer.email !== profile?.email), [peers, profile?.email]);
  const creditPercent = credit ? Math.min(100, Math.round((credit.used / credit.limit) * 100)) : 0;

  return (
    <main className="page">
      <div className="spread" style={{ marginBottom: '1.2rem' }}>
        <div>
          <div className="row" style={{ gap: '0.6rem', marginBottom: '0.35rem' }}>
            <Link href="/documents" className="muted">← Mes documents</Link>
            <span className={`badge ${statusInfo.tone}`}>{statusInfo.text}</span>
            {blocked && <span className="badge danger">écriture bloquée</span>}
          </div>
          <h1 className="title">{detail?.document.title ?? 'Document'}</h1>
          <p className="subtitle">
            {seq} modifications acceptées · {detail?.document.textLength ?? 0} caractères ·{' '}
            {detail?.role === 'owner' ? 'propriétaire' : 'éditeur'}
          </p>
        </div>
        <div className="row">
          {credit && (
            <div style={{ minWidth: 190 }}>
              <div className="muted" style={{ marginBottom: '0.3rem' }}>
                Crédit : {credit.remaining} / {credit.limit} restants
              </div>
              <div className="credit-bar">
                <span style={{ width: `${creditPercent}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="alert danger" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}
      {notice && (
        <div className="alert ok" style={{ marginBottom: '1rem' }}>
          {notice}
        </div>
      )}
      {blocked && (
        <div className="alert danger" style={{ marginBottom: '1rem' }}>
          Crédit épuisé ou écriture bloquée : vous êtes en lecture seule jusqu'à la recharge ({blocked.slice(0, 16).replace('T', ' ')} UTC).
        </div>
      )}

      <div className="row" style={{ marginBottom: '0.8rem', gap: '0.5rem' }}>
        <span className="muted">Présents :</span>
        {profile && (
          <span className="peer">
            <span className="dot" style={{ background: '#6d8bff' }} /> {profile.name} (vous)
          </span>
        )}
        {others.map((peer) => (
          <span key={peer.email} className="peer">
            <span className="dot" style={{ background: peer.color }} /> {peer.name}
          </span>
        ))}
        {others.length === 0 && <span className="muted">personne d'autre pour l'instant</span>}
      </div>

      <div className="editor-shell">
        <div ref={editorHost} />
      </div>

      <div className="grid two" style={{ marginTop: '1.4rem' }}>
        <section className="card">
          <strong>Lien de téléchargement</strong>
          <p className="muted">
            Parution : chaque visiteur réserve un exemplaire ; le PDF reflète le document au moment de sa réservation.
          </p>
          <div className="row" style={{ marginTop: '0.6rem' }}>
            <input
              type="number"
              min={1}
              max={100000}
              value={maxDownloads}
              onChange={(event) => setMaxDownloads(Number(event.target.value))}
              style={{ width: 120 }}
            />
            <button className="primary" type="button" onClick={createLink} disabled={busy}>
              Créer le lien
            </button>
          </div>
          {detail?.links && detail.links.length > 0 && (
            <div className="list" style={{ marginTop: '0.9rem' }}>
              {detail.links.map((link: LinkSummary) => (
                <div key={link.token} className="list-item">
                  <div>
                    <div className="code">/d?token={link.token}</div>
                    <div className="muted">
                      {link.remaining} / {link.maxDownloads} restants
                    </div>
                  </div>
                  <span className={`badge ${link.status === 'ACTIVE' ? 'ok' : 'danger'}`}>
                    {link.status === 'ACTIVE' ? 'actif' : 'épuisé'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <strong>Rédacteurs</strong>
          <form className="row" onSubmit={share} style={{ marginTop: '0.6rem' }}>
            <input
              type="email"
              value={newMember}
              onChange={(event) => setNewMember(event.target.value)}
              placeholder="collegue@exemple.cm"
              style={{ flex: 1, minWidth: 160 }}
            />
            <button type="submit" disabled={busy || !newMember.trim()}>
              Ajouter
            </button>
          </form>
          <div className="list scroll-y" style={{ marginTop: '0.9rem' }}>
            {detail?.members.map((member) => (
              <div key={member.email} className="list-item">
                <div>
                  <strong>{member.name}</strong>
                  <div className="muted">{member.email}</div>
                </div>
                <span className="badge">{member.role === 'owner' ? 'propriétaire' : 'éditeur'}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="spread">
            <strong>Versions</strong>
            <button type="button" onClick={saveVersion} disabled={busy}>
              Enregistrer une version
            </button>
          </div>
          <p className="muted">La restauration applique un nouvel update : rien n'est effacé de l'historique.</p>
          <div className="list scroll-y" style={{ marginTop: '0.6rem' }}>
            {versions.length === 0 && <p className="muted">Aucune version enregistrée.</p>}
            {versions.map((version) => (
              <div key={version.n} className="list-item">
                <div>
                  <strong>{version.label}</strong>
                  <div className="muted">
                    n° {version.n} · {version.chars} caractères · {version.createdAt.slice(0, 16).replace('T', ' ')}
                  </div>
                </div>
                <button type="button" onClick={() => restore(version.n)} disabled={busy || Boolean(blocked)}>
                  Restaurer
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <strong>Comment ça tient</strong>
          <dl className="kv" style={{ marginTop: '0.6rem' }}>
            <dt>Fusion</dt>
            <dd>CRDT Yjs : convergence même en écriture simultanée au même endroit.</dd>
            <dt>Persistance</dt>
            <dd>Une transaction atomique par update : séquence, contenu, crédit, idempotence.</dd>
            <dt>Transport</dt>
            <dd>JSON + Base64 (16 Ko max), regroupement des frappes toutes les 300 ms.</dd>
            <dt>Repli</dt>
            <dd>Si le WebSocket échoue, les mêmes updates passent en HTTP.</dd>
          </dl>
        </section>
      </div>
    </main>
  );
}

export default function DocPage() {
  return (
    <Suspense fallback={<main className="page"><p className="muted">Chargement de l'éditeur…</p></main>}>
      <EditorScreen />
    </Suspense>
  );
}
