'use client';

/**
 * Page d'entrée (section 7) : nom + e-mail → session.
 * Aucun mot de passe, aucun compte à créer : c'est ce que le sujet autorise.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, loadSession, saveSession, ApiError } from '../lib/api';
import { isValidEmail } from '../lib/utils';

export default function EntryPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string; global?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loadSession()) router.replace('/documents');
  }, [router]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: typeof errors = {};
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (trimmedName.length < 1 || trimmedName.length > 60) {
      nextErrors.name = 'Entrez votre nom (60 caractères maximum).';
    }
    if (!isValidEmail(trimmedEmail)) {
      nextErrors.email = 'Adresse e-mail invalide.';
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setBusy(true);
    try {
      const result = await api.createSession(trimmedName, trimmedEmail);
      saveSession({ token: result.token, name: result.user.name, email: result.user.email });
      router.push('/documents');
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : 'Connexion impossible. Réessayez dans un instant.';
      setErrors({ global: message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page-center">
      <div className="card" style={{ width: 400, maxWidth: '100%', padding: 32 }}>
        <h1 style={{ marginBottom: 8 }}>Éditeur de documents partagé</h1>
        <p className="muted" style={{ marginBottom: 24 }}>
          Entrez votre nom et votre e-mail pour écrire avec les autres rédacteurs.
        </p>

        <form className="stack" onSubmit={submit} noValidate>
          <div>
            <label htmlFor="name">Nom</label>
            <input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Votre nom"
              autoComplete="name"
              maxLength={60}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? 'name-error' : undefined}
            />
            {errors.name && (
              <p className="field-error" id="name-error" role="alert">
                {errors.name}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="email">Adresse e-mail</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="vous@exemple.com"
              autoComplete="email"
              maxLength={254}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'email-error' : undefined}
            />
            {errors.email && (
              <p className="field-error" id="email-error" role="alert">
                {errors.email}
              </p>
            )}
          </div>

          {errors.global && (
            <p className="field-error" role="alert">
              {errors.global}
            </p>
          )}

          <button type="submit" className="btn-primary btn-block" disabled={busy}>
            {busy ? 'Connexion…' : 'Entrer'}
          </button>
        </form>
      </div>
    </main>
  );
}
