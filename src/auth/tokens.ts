import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { randomToken, sha256 } from '../common/crypto';

/*
 * Two credential types that can never be mistaken for each other:
 * - users send a short-lived JWT as `Authorization: Bearer …` (HS256 only; issuer, audience and
 *   token type checked), plus an opaque refresh token to renew it;
 * - integrations send an API key as `X-API-Key: rbac_<prefix>_<secret>`.
 * A JWT only says who the caller is. What they may do is read from the database on every request,
 * so a role change or a disabled account takes effect at once instead of when a token expires.
 */

const ISSUER = 'rbac-api';
const AUDIENCE = 'rbac-api';

export interface AccessClaims {
  userId: string;
  orgId: string;
  /** The login this token descends from (its refresh token family), when it came from one. */
  sessionId?: string;
}

export function signAccessToken(secret: string, ttlSeconds: number, claims: AccessClaims): string {
  return jwt.sign({ org: claims.orgId, typ: 'access', ...(claims.sessionId ? { sid: claims.sessionId } : {}) }, secret, {
    algorithm: 'HS256', subject: claims.userId, issuer: ISSUER, audience: AUDIENCE, expiresIn: ttlSeconds, jwtid: randomUUID(),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the claims of a valid access token and when it stops being one, or null for anything else. */
export function verifyAccessToken(secret: string, token: string): (AccessClaims & { expiresAt: Date }) | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload !== 'object' || payload.typ !== 'access') return null;
    const { sub, org, sid, exp } = payload as { sub?: unknown; org?: unknown; sid?: unknown; exp?: unknown };
    if (typeof sub !== 'string' || typeof org !== 'string' || !UUID.test(sub) || !UUID.test(org)) return null;
    if (typeof exp !== 'number') return null; // a token that never expires is not one of ours
    if (sid !== undefined && (typeof sid !== 'string' || !UUID.test(sid))) return null;
    return { userId: sub, orgId: org, ...(sid === undefined ? {} : { sessionId: sid }), expiresAt: new Date(exp * 1000) };
  } catch {
    return null;
  }
}

/** Refresh tokens are random and stored only as a hash. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = `rt_${randomToken()}`;
  return { token, hash: sha256(token) };
}

export const REFRESH_TOKEN_FORMAT = /^rt_[A-Za-z0-9_-]{43}$/;

export const API_KEY_FORMAT = /^rbac_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

/** A new API key: shown to its creator once; only the prefix and a hash of the secret are kept. */
export function newApiKey(): { key: string; prefix: string; secretHash: string } {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomToken();
  return { key: `rbac_${prefix}_${secret}`, prefix, secretHash: sha256(secret) };
}
