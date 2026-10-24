'use client';

/** Notifications (section 6.4) : 320 px, disparition après 4 s, 3 au plus. */
import { useEffect } from 'react';

export interface Toast {
  id: string;
  message: string;
  variant: 'success' | 'error';
}

interface Props {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 4000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div className={`toast toast-${toast.variant}`} role="status">
      <span>{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Fermer la notification"
        style={{ background: 'transparent', border: 0, height: 'auto', padding: 0, color: 'inherit' }}
      >
        ×
      </button>
    </div>
  );
}

export default function Toasts({ toasts, onDismiss }: Props) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.slice(-3).map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
