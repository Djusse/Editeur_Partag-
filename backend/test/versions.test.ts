/**
 * Restauration de version : l'update produit doit **remplacer** le texte,
 * pas s'y ajouter. C'est le piège classique : calculer la différence sur un
 * document vide produit des insertions sans suppression, qui se cumulent.
 *
 * Les tests simulent le cas réel : tous les clients partagent le **même
 * historique** (mêmes identifiants d'items CRDT), puisque l'état est reconstruit
 * depuis le journal commun. On crée donc le second client en rejouant l'état
 * du premier, et non en insérant du texte indépendamment.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

interface RestoreResult {
  update: Uint8Array;
  source: Y.Doc;
}

/** Reproduit l'algorithme de `buildReplacementUpdate` sur un état donné. */
function replaceText(current: Y.Doc, targetText: string): RestoreResult {
  const text = current.getText('content');
  const captured: Uint8Array[] = [];
  const origin = Symbol('restore');
  const listener = (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin === origin) captured.push(update);
  };
  current.on('update', listener);
  try {
    current.transact(() => {
      const existing = text.toString();
      let start = 0;
      const maxStart = Math.min(existing.length, targetText.length);
      while (start < maxStart && existing[start] === targetText[start]) start++;

      let endExisting = existing.length;
      let endTarget = targetText.length;
      while (endExisting > start && endTarget > start && existing[endExisting - 1] === targetText[endTarget - 1]) {
        endExisting--;
        endTarget--;
      }

      if (endExisting > start) text.delete(start, endExisting - start);
      if (endTarget > start) text.insert(start, targetText.slice(start, endTarget));
    }, origin);
  } finally {
    current.off('update', listener);
  }
  return { update: Y.mergeUpdates(captured), source: current };
}

/** Crée deux clients partageant le même historique, comme dans l'application. */
function sharedClients(initialText: string): { a: Y.Doc; b: Y.Doc } {
  const a = new Y.Doc();
  a.getText('content').insert(0, initialText);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return { a, b };
}

describe('restauration de version', () => {
  it('remplace le texte au lieu de l\'ajouter (cas divergent)', () => {
    const { a, b } = sharedClients('version actuelle');
    const { update } = replaceText(a, 'version ancienne');
    Y.applyUpdate(b, update);

    expect(a.getText('content').toString()).toBe('version ancienne');
    expect(b.getText('content').toString()).toBe('version ancienne');
  });

  it('supprime tout quand la version cible est vide', () => {
    const { a, b } = sharedClients('du texte à effacer');
    const { update } = replaceText(a, '');
    Y.applyUpdate(b, update);

    expect(a.getText('content').toString()).toBe('');
    expect(b.getText('content').toString()).toBe('');
  });

  it('insère tout quand le document courant est vide', () => {
    const { a, b } = sharedClients('');
    const { update } = replaceText(a, 'contenu restauré');
    Y.applyUpdate(b, update);

    expect(b.getText('content').toString()).toBe('contenu restauré');
  });

  it('préserve le texte commun et ne remplace que la partie divergente', () => {
    const common = 'Le journal de l\'association — édition ';
    const { a, b } = sharedClients(`${common}2026`);
    const { update } = replaceText(a, `${common}2025`);
    Y.applyUpdate(b, update);

    expect(b.getText('content').toString()).toBe(`${common}2025`);
  });

  it('converge sur un troisième client qui reçoit les deux états', () => {
    const { a } = sharedClients('texte courant');
    const { update } = replaceText(a, 'texte restauré');

    const clientC = new Y.Doc();
    Y.applyUpdate(clientC, Y.encodeStateAsUpdate(a));
    expect(clientC.getText('content').toString()).toBe('texte restauré');
  });

  it('est idempotent : appliquer deux fois ne change rien', () => {
    const { a, b } = sharedClients('contenu initial');
    const { update } = replaceText(a, 'contenu final');
    Y.applyUpdate(b, update);
    Y.applyUpdate(b, update);

    expect(b.getText('content').toString()).toBe('contenu final');
  });

  it('retrouve le contenu d\'origine quand on restaure l\'état de départ', () => {
    const original = 'édition originale du journal';
    const { a, b } = sharedClients(original);

    // Le document évolue après la version enregistrée.
    const edits: Uint8Array[] = [];
    a.on('update', (update: Uint8Array) => edits.push(update));
    a.getText('content').insert(a.getText('content').length, ' — chapitre ajouté');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Retour à la version d'origine.
    const { update } = replaceText(a, original);
    Y.applyUpdate(b, update);

    expect(b.getText('content').toString()).toBe(original);
  });
});
