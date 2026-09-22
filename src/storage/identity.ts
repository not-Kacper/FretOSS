/**
 * Anonymous sync identity — not a login system.
 *
 * A 256-bit (32-byte) cryptographically random token, hex-encoded, stored in
 * localStorage. It is the D1 row owner. It is never derived from userAgent,
 * timestamps, email, or anything guessable — there is no account to hash.
 */

export const USER_TOKEN_KEY = 'srs-fretboard.user-token';
export const USER_TOKEN_BYTES = 32;
export const USER_TOKEN_HEX_LENGTH = USER_TOKEN_BYTES * 2;

/** Stable for the life of the page when localStorage is unavailable. */
let fallbackToken: string | null = null;

export function generateUserToken(): string {
  const bytes = new Uint8Array(USER_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isValidUserToken(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  return trimmed.length === USER_TOKEN_HEX_LENGTH && /^[0-9a-f]+$/i.test(trimmed);
}

/**
 * Generates a 256-bit random token on first call, persists it, and returns
 * the existing one on subsequent calls.
 */
export function getOrCreateUserId(): string {
  try {
    const existing = localStorage.getItem(USER_TOKEN_KEY);
    if (isValidUserToken(existing)) return existing.trim().toLowerCase();
    const token = generateUserToken();
    localStorage.setItem(USER_TOKEN_KEY, token);
    return token;
  } catch {
    fallbackToken ??= generateUserToken();
    return fallbackToken;
  }
}

/** Adopt a token from an imported backup so this browser reclaims that D1 row. */
export function setUserId(token: string): void {
  if (!isValidUserToken(token)) {
    throw new Error('Cannot adopt an invalid user token.');
  }
  const normalized = token.trim().toLowerCase();
  try {
    localStorage.setItem(USER_TOKEN_KEY, normalized);
  } catch {
    // Storage blocked: keep it for this page only.
  }
  fallbackToken = normalized;
}
