'use client';

/**
 * Modale accessible (section 6.5) : voile, fermeture par Échap ou clic sur le
 * voile, focus piégé dans la boîte et rendu au bouton d'origine à la fermeture.
 */
import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({ title, onClose, children }: Props) {
  const box = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;

    /**
     * Priorité de focus à l'ouverture :
     *   1. un élément explicitement marqué `data-autofocus` (le champ principal) ;
     *   2. le premier **champ de saisie** ;
     *   3. à défaut, le premier élément focusable.
     *
     * Ne PAS se fier à `autofocus` : React l'ignore après le montage, et l'ordre
     * du DOM place le bouton « × » avant le champ — le focus atterrissait donc
     * sur la croix, et la frappe suivante fermait la modale.
     */
    const candidates = box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [];
    const list = [...candidates].filter((element) => element.offsetParent !== null);
    const explicit = list.find((element) => element.hasAttribute('data-autofocus'));
    const firstField = list.find((element) =>
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName),
    );
    (explicit ?? firstField ?? list[0] ?? box.current)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !box.current) return;

      // Piège de focus : Tab reste dans la modale.
      const elements = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null,
      );
      if (elements.length === 0) return;

      const firstElement = elements[0];
      const lastElement = elements[elements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
      previousFocus.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" ref={box} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
