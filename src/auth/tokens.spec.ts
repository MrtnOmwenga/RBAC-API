import jwt from 'jsonwebtoken';
import { API_KEY_FORMAT, newApiKey, newRefreshToken, REFRESH_TOKEN_FORMAT, signAccessToken, verifyAccessToken } from './tokens';

const SECRET = 's'.repeat(32);
const claims = { userId: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222' };

test('access tokens round-trip', () => {
  const before = Date.now();
  const read = verifyAccessToken(SECRET, signAccessToken(SECRET, 60, claims));
  expect(read).toEqual({ ...claims, expiresAt: expect.any(Date) as Date });
  // The expiry is the token's own, to the second.
  expect(read!.expiresAt.getTime()).toBeGreaterThan(before + 58_000);
  expect(read!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  expect(verifyAccessToken('t'.repeat(32), signAccessToken(SECRET, 60, claims))).toBeNull();
});

test('a token from a login carries its session; one without a login carries none', () => {
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const token = signAccessToken(SECRET, 60, { ...claims, sessionId });
  expect(jwt.decode(token)).toMatchObject({ sid: sessionId });
  expect(verifyAccessToken(SECRET, token)).toMatchObject({ ...claims, sessionId });
  expect(jwt.decode(signAccessToken(SECRET, 60, claims))).not.toHaveProperty('sid');
  expect(verifyAccessToken(SECRET, signAccessToken(SECRET, 60, claims))).not.toHaveProperty('sessionId');
});

test('tokens carry this service as issuer and audience, and only HS256 access tokens pass', () => {
  const token = signAccessToken(SECRET, 60, claims);
  expect(jwt.decode(token)).toMatchObject({ iss: 'rbac-api', aud: 'rbac-api', typ: 'access', sub: claims.userId, org: claims.orgId });
  const sign = (payload: object, options: jwt.SignOptions = {}) => jwt.sign({ org: claims.orgId, typ: 'access', ...payload }, SECRET, {
    algorithm: 'HS256', subject: claims.userId, issuer: 'rbac-api', audience: 'rbac-api', expiresIn: 60, ...options,
  });
  expect(verifyAccessToken(SECRET, sign({}))).toMatchObject(claims);
  expect(verifyAccessToken(SECRET, sign({ sid: 'not-a-session' }))).toBeNull();
  expect(verifyAccessToken(SECRET, sign({ sid: 7 }))).toBeNull();
  expect(verifyAccessToken(SECRET, sign({ sid: `${claims.orgId}x` }))).toBeNull();
  // A token with no expiry would never stop working: refused.
  expect(verifyAccessToken(SECRET, jwt.sign({ org: claims.orgId, typ: 'access' }, SECRET, {
    algorithm: 'HS256', subject: claims.userId, issuer: 'rbac-api', audience: 'rbac-api',
  }))).toBeNull();
  expect(verifyAccessToken(SECRET, sign({}, { algorithm: 'HS512' }))).toBeNull();
  expect(verifyAccessToken(SECRET, sign({}, { issuer: 'other' }))).toBeNull();
  expect(verifyAccessToken(SECRET, sign({}, { audience: 'other' }))).toBeNull();
  expect(verifyAccessToken(SECRET, sign({ typ: 'refresh' }))).toBeNull();
  expect(verifyAccessToken(SECRET, sign({ org: `x${claims.orgId}` }))).toBeNull();
  expect(verifyAccessToken(SECRET, sign({ org: `${claims.orgId}x` }))).toBeNull();
  expect(verifyAccessToken(SECRET, sign({}, { subject: `${claims.userId}x` }))).toBeNull();
});

test('credential formats are anchored at both ends', () => {
  const { token } = newRefreshToken();
  const { key } = newApiKey();
  for (const bad of [`x${token}`, `${token}x`]) expect(REFRESH_TOKEN_FORMAT.test(bad)).toBe(false);
  for (const bad of [`x${key}`, `${key}x`]) expect(API_KEY_FORMAT.test(bad)).toBe(false);
});

test('generated refresh tokens and API keys match the formats the server accepts', () => {
  expect(newRefreshToken().token).toMatch(REFRESH_TOKEN_FORMAT);
  const key = newApiKey();
  expect(key.key).toMatch(API_KEY_FORMAT);
  expect(API_KEY_FORMAT.exec(key.key)?.[1]).toBe(key.prefix);
  expect(key.key).not.toContain(key.secretHash);
});
