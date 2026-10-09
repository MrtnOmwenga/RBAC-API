import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { API_KEY_FORMAT, signAccessToken } from '../src/auth/tokens';
import { sql } from 'kysely';
import { HousekeepingService } from '../src/housekeeping/housekeeping.service';
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
  // The secret is base64url, which may itself contain "_": take it with the key format, not split().
  const secret = API_KEY_FORMAT.exec(key.headers['x-api-key']!)![2]!;
  expect(secret).toHaveLength(43);
  expect(body).not.toContain(secret);
});

test("an API key's last use is recorded to the minute, so reads don't each write a row", async () => {
  const fresh = await createKey(t.owner, orgId, admin.principal.id);
  const lastUsed = async () => (await t.owner.selectFrom('api_keys').select('last_used_at').where('id', '=', fresh.principal.id).executeTakeFirstOrThrow()).last_used_at;
  expect(await lastUsed()).toBeNull();
  await t.http().get('/me').set(fresh.headers).expect(200);
  const first = await lastUsed();
  expect(first).not.toBeNull();
  await t.http().get('/me').set(fresh.headers).expect(200);
  expect(await lastUsed()).toEqual(first);
  await t.owner.updateTable('api_keys').set({ last_used_at: new Date(Date.now() - 5 * 60_000) }).where('id', '=', fresh.principal.id).execute();
  await t.http().get('/me').set(fresh.headers).expect(200);
  expect((await lastUsed())!.getTime()).toBeGreaterThan(Date.now() - 60_000);
});

test('housekeeping deletes refresh tokens that can do nothing, and keeps the ones that detect theft', async () => {
  const family = randomUUID();
  const row = (name: string, fields: object) => ({
    org_id: orgId, user_id: admin.principal.id, family_id: family, token_hash: `${name}-${randomUUID()}`,
    expires_at: new Date(Date.now() + 86_400_000), ...fields,
  });
  const days = (n: number) => new Date(Date.now() - n * 86_400_000);
  await t.owner.insertInto('refresh_tokens').values([
    row('expired', { expires_at: days(1) }),
    row('revoked-long-ago', { revoked_at: days(2) }),
    row('revoked-today', { revoked_at: new Date() }),
    row('used', { used_at: days(3) }), // presenting this again is how a copy is noticed
    row('live', {}),
  ]).execute();
  const { refreshTokens } = await t.app.get(HousekeepingService).run();
  expect(refreshTokens).toBeGreaterThanOrEqual(2);
  const left = (await t.owner.selectFrom('refresh_tokens').select('token_hash').where('family_id', '=', family).execute()).map((r) => r.token_hash.split('-')[0]).sort();
  expect(left).toEqual(['live', 'revoked', 'used']);
  // The API's own role still can't delete tokens directly: only through the function.
  await expect(sql`delete from refresh_tokens`.execute(t.appDb)).rejects.toThrow(/permission denied/);
});
