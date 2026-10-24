'use client';

/**
 * Barre supérieure des pages du rédacteur (section 6.1).
 * Hauteur 56 px : « Éditeur partagé » à gauche, jauge, identité, « Changer d'identité ».
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
      title={`Recharge à ${formatTime(credit.resetsAt)} (minuit UTC)`}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}
    >
      <span className="small" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatNumber(credit.remaining)} / {formatNumber(credit.limit)} caractères
      </span>
      <div className="credit-track" style={{ width: 120 }}>
        <div className={`credit-fill ${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export default function TopBar({ session, credit }: Props) {
  const router = useRouter();

  return (
    <header
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
      <Link
        href="/documents"
        style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', textDecoration: 'none' }}
      >
        Éditeur partagé
      </Link>

      <div className="row" style={{ gap: 16 }}>
        <CreditMeter credit={credit} />

        {session && (
          <div style={{ textAlign: 'right', lineHeight: 1.3 }}>
            <div className="small">{session.name}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {session.email}
            </div>
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
