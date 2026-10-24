/**
 * Compartiment CodeMirror pour basculer l'éditeur en lecture seule.
 *
 * `EditorView.editable` est un `Facet` : on ne peut pas le modifier directement
 * sur une vue existante, il faut passer par un `Compartment` que l'on
 * reconfigure. C'est ce qui permet de garder la réception et la présence
 * actives tout en bloquant la frappe (section 9.6).
 */
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export const editableCompartment = new Compartment();

export function setReadOnly(view: EditorView | null, readOnly: boolean): void {
  if (!view) return;
  view.dispatch({
    effects: editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
  });
}
