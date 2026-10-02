// 8-character crypto-random ids from [0-9a-z], used for image files, frames, docs and jobs.
// Uses globalThis.crypto (renderer, Electron main and Node ≥ 19).

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export const UID_LENGTH = 8;
export const UID_RE = /^[0-9a-z]{8}$/;

export const isUid = (s: unknown): s is string => typeof s === 'string' && UID_RE.test(s);

/** Unbiased: bytes ≥ 252 (= 7·36) are rejected. */
export function uid(): string {
  let out = '';
  const bytes = new Uint8Array(16);
  while (out.length < UID_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < 252 && out.length < UID_LENGTH)
        out += ALPHABET[b % 36];
    }
  }
  return out;
}
