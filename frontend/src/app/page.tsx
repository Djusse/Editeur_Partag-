'use client';

/** Écran d'entrée : un nom et un e-mail suffisent (pas de compte à gérer). */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getToken, setSession, ApiError } from '../lib/api';

export default function EntryPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (getToken()) router.replace('/documents');
  }, [router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createSession(name.trim(), email.trim().toLowerCase());
      setSession(result.token, result.session);
      router.push('/documents');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="hero">
      <div className="hero-card">
        <h1 className="title">Éditeur de documents partagé</h1>
        <p className="subtitle" style={{ marginBottom: '1.6rem' }}>
          Écrivez à plusieurs, en temps réel. Chaque rédacteur dispose de 10 000 caractères par jour.
        </p>

        <form className="stack" onSubmit={submit}>
          <div>
            <label htmlFor="name">Nom affiché</label>
            <input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Awa Nkemta"
              maxLength={80}
              required
              autoComplete="name"
            />
          </div>
          <div>
            <label htmlFor="email">Adresse e-mail</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="awa@exemple.cm"
              required
              autoComplete="email"
            />
            <p className="muted" style={{ marginTop: '0.5rem' }}>
              L'e-mail identifie le crédit d'écriture partagé entre vos appareils. Aucun mot de passe n'est demandé.
            </p>
          </div>

          {error && <div className="alert danger">{error}</div>}

          <button className="primary" type="submit" disabled={busy || !name.trim() || !email.trim()}>
            {busy ? 'Connexion…' : 'Entrer dans l\'éditeur'}
          </button>
        </form>

        <p className="muted" style={{ marginTop: '1.2rem' }}>
          Visiteur d'un lien de téléchargement ? Ouvrez directement le lien reçu (<code>/d?token=…</code>).
        </p>
      </div>
    </main>
  );
}
