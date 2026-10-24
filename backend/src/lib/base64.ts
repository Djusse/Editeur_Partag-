/**
 * Conversions Base64 (les updates Yjs sont binaires, WebSocket et JSON sont
 * textuels : le Base64 est obligatoire et coûte +33 % de taille).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) return new Uint8Array();
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

/** Taille binaire estimée sans décoder (rapide et suffisant pour un plafond). */
export function base64Size(value: string): number {
  return Math.floor((value.length * 3) / 4);
}
