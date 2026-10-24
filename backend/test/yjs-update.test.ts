import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { countUpdate, creditCost, InvalidUpdateError } from '../src/lib/yjs-update';

/** Construit un update incrémental à partir d'un document utilitaire. */
function makeUpdate(build: (text: Y.Text) => void): Uint8Array {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  const received: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => received.push(update));
  build(text);
  return received[received.length - 1];
}

describe('comptage des caractères d\'un update Yjs', () => {
  it('compte les caractères insérés', () => {
    const update = makeUpdate((text) => text.insert(0, 'bonjour'));
    const { cost, counts } = creditCost(update);
    expect(counts.inserted).toBe(7);
    expect(counts.deleted).toBe(0);
    expect(cost).toBe(7);
  });

  it('compte les suppressions', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'abcdefghij');
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    text.delete(2, 3);
    const update = updates[updates.length - 1];
    const counts = countUpdate(update);
    expect(counts.deleted).toBe(3);
    expect(counts.inserted).toBe(0);
  });

  it('compte insertions et suppressions dans un même update', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'abcd');
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    doc.transact(() => {
      text.delete(0, 2);
      text.insert(1, 'xyz');
    });
    const counts = countUpdate(updates[updates.length - 1]);
    expect(counts.deleted).toBe(2);
    expect(counts.inserted).toBe(3);
  });

  it('accepte un update d\'état complet (encodeStateAsUpdate)', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'état complet');
    const state = Y.encodeStateAsUpdate(doc);
    const counts = countUpdate(state);
    expect(counts.inserted).toBe('état complet'.length);
    expect(counts.deleted).toBe(0);
  });

  it('accepte un delta d\'un client distant', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText('content').insert(0, 'salut');
    const sync = Y.encodeStateAsUpdate(a);
    const deltas: Uint8Array[] = [];
    b.on('update', (u: Uint8Array) => deltas.push(u));
    Y.applyUpdate(b, sync);
    const counts = countUpdate(deltas[deltas.length - 1]);
    expect(counts.inserted + counts.deleted).toBeGreaterThanOrEqual(0);
    expect(() => countUpdate(deltas[deltas.length - 1])).not.toThrow();
  });

  it('compte l\'unicode comme le ferait Yjs (unités UTF-16)', () => {
    const update = makeUpdate((text) => text.insert(0, 'héllo'));
    expect(countUpdate(update).inserted).toBe(5);
  });

  it('rejette un update vide ou corrompu', () => {
    expect(() => countUpdate(new Uint8Array())).toThrow(InvalidUpdateError);
    expect(() => countUpdate(new Uint8Array([0xff, 0xff, 0xff]))).toThrow(InvalidUpdateError);
  });
});
