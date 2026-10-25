'use client';

/**
 * Barre supérieure des pages du rédacteur (section 6.1).
 *
 * Responsive : sur mobile (< 768 px), la jauge, le nom et le bouton
 * « Changer d'identité » ne tiennent pas sur une ligne. On masque le bloc
 * d'identité détaillé et l'on ne garde que l'essentiel : le titre, la jauge
 * compacte et le lien de sortie. Sans cela, la barre débordait et recouvrait
 * le contenu (constaté en essai).
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearSession, type Credit, type Session } from '../lib/api';
import { formatNumber, formatTime } from '../lib/utils';

interface Props {
  session: Session | null;
  credit: Credit | null;
}

export function CreditMeter({ credit }: { credit: Credit | null }) {
  if (!credit) {
    return <span className="muted">…</span>;
  }

  const ratio = credit.limit > 0 ? credit.remaining / credit.limit : 0;
  const percent = Math.max(0, Math.min(100, ratio * 100));
  const tone = ratio === 0 ? 'credit-fill-danger' : ratio < 0.3 ? 'credit-fill-warning' : '';

  return (
    <div
      className="credit-meter"
      title={`Recharge à ${formatTime(credit.resetsAt)} (minuit heure de Douala)`}
    >
      <span className="credit-meter-text">
        {formatNumber(credit.remaining)} / {formatNumber(credit.limit)} caractères
      </span>
      <div className="credit-track">
        <div className={`credit-fill ${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export default function TopBar({ session, credit }: Props) {
  const router = useRouter();

  return (
    <header className="topbar">
      <Link href="/documents" className="topbar-brand">
        Éditeur partagé
      </Link>

      <div className="topbar-right">
        <Link href="/admin" className="btn-ghost topbar-admin">
          Supervision
        </Link>

        <CreditMeter credit={credit} />

        {session && (
          <div className="topbar-identity">
            <div className="topbar-name">{session.name}</div>
            <div className="topbar-email">{session.email}</div>
          </div>
        )}

        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            clearSession();
            router.replace('/');
          }}
        >
          Changer d&#8217;identité
        </button>
      </div>
    </header>
  );
}
