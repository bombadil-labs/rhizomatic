/** Canonical Ed25519 peer spelling and conservative identity comparison for untrusted sources. */
const CANONICAL = /^ed25519:[0-9a-f]{64}$/;
const KEY_HEX = /^[0-9a-f]{64}$/i;

export function isCanonicalPeerId(value: string): boolean {
  return CANONICAL.test(value);
}

function keyHex(value: string): string | undefined {
  const raw = /^ed25519:/i.test(value) ? value.slice("ed25519:".length) : value;
  return KEY_HEX.test(raw) ? raw.toLowerCase() : undefined;
}

/** Treat recognized public-key spellings as the same key, even before canonical validation. */
export function samePeerId(a: string, b: string): boolean {
  if (a === b) return true;
  const left = keyHex(a);
  return left !== undefined && left === keyHex(b);
}
