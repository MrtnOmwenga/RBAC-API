import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { signAccessToken } from '../src/auth/tokens';
import { createTestApp, TEST_JWT_SECRET, type TestApp } from './support/app';
import { createKey, createOrg, createUser, type Actor } from './support/world';

/*
 * Forged, altered, expired and misplaced credentials. Every one must be a 401 with the same
 * message: the response never says which check failed.
 */

let t: TestApp;
let orgId: string;
let admin: Actor;
let key: Actor;

beforeAll(async () => {
  t = await createTestApp();
  orgId = await createOrg(t.owner);
  admin = await createUser(t.owner, orgId, 'org_admin', null);
  key = await createKey(t.owner, orgId, admin.principal.id, { scopes: ['document:read'] });
});
afterAll(async () => { await t.close(); });

const token = (payload: object, options: jwt.SignOptions = {}, secret = TEST_JWT_SECRET) => jwt.sign(
  { org: orgId, typ: 'access', ...payload },
  secret,
  { algorithm: 'HS256', subject: admin.principal.id, issuer: 'rbac-api', audience: 'rbac-api', expiresIn: 300, ...options },
);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

const cases: [string, () => Record<string, string>][] = [
  ['no credentials', () => ({})],
  ['a malformed header', () => ({ authorization: 'Token abc' })],
  ['signed with another secret', () => ({ authorization: `Bearer ${token({}, {}, 'another-secret-that-is-32-characters-long!')}` })],
  ['"alg": "none"', () => ({ authorization: `Bearer ${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: admin.principal.id, org: orgId, typ: 'access', iss: 'rbac-api', aud: 'rbac-api' })}.` })],
  ['a payload edited after signing', () => {
    const [header, , signature] = signAccessToken(TEST_JWT_SECRET, 300, { userId: admin.principal.id, orgId }).split('.');
    return { authorization: `Bearer ${header}.${b64({ sub: randomUUID(), org: orgId, typ: 'access', iss: 'rbac-api', aud: 'rbac-api', exp: 9999999999 })}.${signature}` };
  }],
  ['an expired token', () => ({ authorization: `Bearer ${token({}, { expiresIn: -10 })}` })],
  ['the wrong audience', () => ({ authorization: `Bearer ${token({}, { audience: 'another-service' })}` })],
  ['the wrong issuer', () => ({ authorization: `Bearer ${token({}, { issuer: 'someone-else' })}` })],
  ['a token that is not an access token', () => ({ authorization: `Bearer ${token({ typ: 'refresh' })}` })],
  ['a token without a subject', () => ({ authorization: `Bearer ${jwt.sign({ org: orgId, typ: 'access' }, TEST_JWT_SECRET, { algorithm: 'HS256', issuer: 'rbac-api', audience: 'rbac-api', expiresIn: 300 })}` })],
  ['a valid user in the wrong organization claim', () => ({ authorization: `Bearer ${token({ org: randomUUID() })}` })],
  ['a user that does not exist', () => ({ authorization: `Bearer ${token({}, { subject: randomUUID() })}` })],
  ['an API key sent as a bearer token', () => ({ authorization: `Bearer ${key.headers['x-api-key']}` })],
  ['an access token sent as an API key', () => ({ 'x-api-key': admin.headers.authorization!.slice(7) })],
  ['an API key with a wrong secret', () => ({ 'x-api-key': `${key.headers['x-api-key']!.slice(0, -4)}AAAA` })],
  ['both a token and a key', () => ({ ...admin.headers, ...key.headers })],
];

test.each(cases)('rejects %s', async (_name, headers) => {
  const res = await t.http().get('/me').set(headers());
  expect(res.status).toBe(401);
});

test('the genuine credentials work (so the cases above fail for the right reason)', async () => {
  await t.http().get('/me').set(admin.headers).expect(200);
  await t.http().get('/me').set(key.headers).expect(200);
});

test('revoked and expired API keys stop working', async () => {
  const revoked = await createKey(t.owner, orgId, admin.principal.id);
  await t.http().get('/me').set(revoked.headers).expect(200);
  await t.http().delete(`/api-keys/${revoked.principal.id}`).set(admin.headers).expect(204);
  await t.http().get('/me').set(revoked.headers).expect(401);

  const expired = await createKey(t.owner, orgId, admin.principal.id, { expiresAt: new Date(Date.now() - 1000) });
  await t.http().get('/me').set(expired.headers).expect(401);
});

test('credentials never appear in responses or list endpoints', async () => {
  const res = await t.http().get('/api-keys').set(admin.headers).expect(200);
  const body = JSON.stringify(res.body);
  expect(body).not.toMatch(/secret|hash/i);
  expect(body).not.toContain(key.headers['x-api-key']!.split('_')[2]);
});
