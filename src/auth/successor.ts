import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/*
 * Two tabs that refresh at the same instant both present the same refresh token. The second would
 * look like a stolen copy being replayed, and the member would be signed out everywhere.
 *
 * So for a few seconds after a token is used, presenting it again returns the pair it already
 * produced. The server keeps only hashes of refresh tokens, so to hand the successor out a second
 * time it stores it sealed under a key derived from the token it replaced: the server can open it
 * only while holding that token, which is exactly when the second tab asks.
 *
 * Theft is still caught. A thief who replays inside the window gets the same successor as the
 * owner, not a second line of tokens; whichever of them refreshes next spends it, and the other's
 * attempt is then a reuse outside the window.
 */

const keyFrom = (token: string): Buffer => Buffer.from(hkdfSync('sha256', token, Buffer.alloc(0), 'rbac-api/refresh-successor', 32));

export function sealSuccessor(usedToken: string, successor: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(usedToken), iv);
  const body = Buffer.concat([cipher.update(successor, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The successor of `usedToken`, or null if `sealed` wasn't made for it. */
export function openSuccessor(usedToken: string, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(usedToken), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
