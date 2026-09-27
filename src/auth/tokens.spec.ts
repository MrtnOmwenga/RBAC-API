import jwt from 'jsonwebtoken';
import { API_KEY_FORMAT, newApiKey, newRefreshToken, REFRESH_TOKEN_FORMAT, signAccessToken, verifyAccessToken } from './tokens';

const SECRET = 's'.repeat(32);
const claims = { userId: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222' };

test('access tokens round-trip', () => {
  expect(verifyAccessToken(SECRET, signAccessToken(SECRET, 60, claims))).toEqual(claims);
  expect(verifyAccessToken('t'.repeat(32), signAccessToken(SECRET, 60, claims))).toBeNull();
});

test('tokens carry this service as issuer and audience, and only HS256 access tokens pass', () => {
  const token = signAccessToken(SECRET, 60, claims);
  expect(jwt.decode(token)).toMatchObject({ iss: 'rbac-api', aud: 'rbac-api', typ: 'access', sub: claims.userId, org: claims.orgId });
  const sign = (payload: object, options: jwt.SignOptions = {}) => jwt.sign({ org: claims.orgId, typ: 'access', ...payload }, SECRET, {
    algorithm: 'HS256', subject: claims.userId, issuer: 'rbac-api', audience: 'rbac-api', expiresIn: 60, ...options,
  });
  expect(verifyAccessToken(SECRET, sign({}))).toEqual(claims);
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
