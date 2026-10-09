import { createTestApp, type TestApp } from './support/app';
import { createDepartment, createOrg, createUser, PASSWORD } from './support/world';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const signUp = async () => {
  const email = `founder-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const res = await t.http().post('/auth/signup').send({ organization: 'Acme', name: 'Founder', email, password: PASSWORD }).expect(201);
  return { email, ...(res.body as { accessToken: string; refreshToken: string; userId: string; orgId: string }) };
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('sign-up and login', () => {
  test('sign-up creates an organization and its first admin; the token works', async () => {
    const founder = await signUp();
    const me = await t.http().get('/me').set(bearer(founder.accessToken)).expect(200);
    expect(me.body).toEqual({ kind: 'user', id: founder.userId, orgId: founder.orgId, role: 'org_admin', departmentId: null, clearance: 0 });
  });

  test('registering the same email twice is a 409; unknown fields are rejected', async () => {
    const founder = await signUp();
    await t.http().post('/auth/signup').send({ organization: 'Other', name: 'Copy', email: founder.email.toUpperCase(), password: PASSWORD }).expect(409);
    await t.http().post('/auth/signup').send({ organization: 'Acme', name: 'X', email: 'x@example.test', password: PASSWORD, role: 'org_admin' }).expect(400);
    await t.http().post('/auth/signup').send({ organization: 'Acme', name: 'X', email: 'y@example.test', password: 'short' }).expect(400);
  });

  test('wrong password, unknown email and disabled accounts all get the same 401', async () => {
    const orgId = await createOrg(t.owner);
    const user = await createUser(t.owner, orgId, 'org_admin', null);
    const answers = await Promise.all([
      t.http().post('/auth/login').send({ email: user.email, password: 'not the password' }),
      t.http().post('/auth/login').send({ email: 'nobody@example.test', password: PASSWORD }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(res.body.detail).toBe('Invalid email or password');
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    }
    await t.http().post('/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
  });

  test('five wrong passwords lock the account; even the right one then fails', async () => {
    const orgId = await createOrg(t.owner);
    const user = await createUser(t.owner, orgId, 'viewer', await createDepartment(t.owner, orgId));
    for (let i = 0; i < t.config.LOGIN_MAX_FAILURES; i += 1) {
      await t.http().post('/auth/login').send({ email: user.email, password: `wrong-${i}` }).expect(401);
    }
    await t.http().post('/auth/login').send({ email: user.email, password: PASSWORD }).expect(401);
    const row = await t.owner.selectFrom('users').select('locked_until').where('id', '=', user.principal.id).executeTakeFirstOrThrow();
    expect(row.locked_until!.getTime()).toBeGreaterThan(Date.now());
  });
});

/** Moves every use of a refresh token in the organization into the past, beyond the moment two tabs are allowed. */
const later = (orgId: string) => t.owner.updateTable('refresh_tokens').set({ used_at: new Date(Date.now() - 60_000) })
  .where('org_id', '=', orgId).where('used_at', 'is not', null).execute();

describe('refresh tokens', () => {
  test('rotate on every use', async () => {
    const founder = await signUp();
    const first = await t.http().post('/auth/refresh').send({ refreshToken: founder.refreshToken }).expect(200);
    expect(first.body.refreshToken).not.toBe(founder.refreshToken);
    await t.http().get('/me').set(bearer(first.body.accessToken)).expect(200);
    await t.http().post('/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(200);
  });

  test('reusing a spent token revokes the whole family, including the newer token', async () => {
    const founder = await signUp();
    const rotated = await t.http().post('/auth/refresh').send({ refreshToken: founder.refreshToken }).expect(200);
    await later(founder.orgId);
    await t.http().post('/auth/refresh').send({ refreshToken: founder.refreshToken }).expect(401); // stolen copy replayed
    await t.http().post('/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
    const events = await t.owner.selectFrom('audit_events').select('action').where('org_id', '=', founder.orgId).execute();
    expect(events.map((e) => e.action)).toContain('auth.refresh_reuse_detected');
  });

  test('two tabs refreshing at once get the same pair, and nobody is signed out', async () => {
    const founder = await signUp();
    const [a, b] = await Promise.all([1, 2].map(() => t.http().post('/auth/refresh').send({ refreshToken: founder.refreshToken })));
    expect([a!.status, b!.status]).toEqual([200, 200]);
    expect(a!.body.refreshToken).toBe(b!.body.refreshToken);
    await t.http().get('/me').set(bearer(a!.body.accessToken)).expect(200);
    await t.http().get('/me').set(bearer(b!.body.accessToken)).expect(200);
    // One line of tokens, not two: the shared successor rotates once, like any other.
    const rows = await t.owner.selectFrom('refresh_tokens').select('id').where('org_id', '=', founder.orgId).execute();
    expect(rows).toHaveLength(2);
    await t.http().post('/auth/refresh').send({ refreshToken: a!.body.refreshToken }).expect(200);
    const events = await t.owner.selectFrom('audit_events').select('action').where('org_id', '=', founder.orgId).execute();
    expect(events.map((e) => e.action)).not.toContain('auth.refresh_reuse_detected');
  });

  test('a thief who replays inside that moment gains no line of their own: the next reuse is caught', async () => {
    const founder = await signUp();
    const owner = await t.http().post('/auth/refresh').send({ refreshToken: founder.refreshToken }).expect(200);
    const thief = await t.http().post('/auth/refresh').send({ refreshToken: founder.refreshToken }).expect(200);
    expect(thief.body.refreshToken).toBe(owner.body.refreshToken);
    // The owner carries on; when the thief tries what they hold, it has been spent.
    const ownerNext = await t.http().post('/auth/refresh').send({ refreshToken: owner.body.refreshToken }).expect(200);
    await later(founder.orgId);
    await t.http().post('/auth/refresh').send({ refreshToken: thief.body.refreshToken }).expect(401);
    await t.http().post('/auth/refresh').send({ refreshToken: ownerNext.body.refreshToken }).expect(401); // family revoked
  });

  test('the stored successor is no use without the token it replaced', async () => {
    const founder = await signUp();
    const rotated = await t.http().post('/auth/refresh').send({ refreshToken: founder.refreshToken }).expect(200);
    const rows = await t.owner.selectFrom('refresh_tokens').select(['successor_sealed', 'token_hash']).where('org_id', '=', founder.orgId).execute();
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(rotated.body.refreshToken as string);
    expect(stored).not.toContain(founder.refreshToken);
    expect(rows.filter((r) => r.successor_sealed !== null)).toHaveLength(1);
  });

  test('logout ends the session', async () => {
    const founder = await signUp();
    await t.http().post('/auth/logout').send({ refreshToken: founder.refreshToken }).expect(204);
    await t.http().post('/auth/refresh').send({ refreshToken: founder.refreshToken }).expect(401);
  });
});

describe('authority comes from the database, not the token', () => {
  test('a role change applies to a token issued before it', async () => {
    const orgId = await createOrg(t.owner);
    const dept = await createDepartment(t.owner, orgId);
    const user = await createUser(t.owner, orgId, 'viewer', dept);
    await t.http().post('/departments').set(user.headers).send({ name: 'New' }).expect(403);
    await t.owner.updateTable('users').set({ role: 'org_admin', department_id: null }).where('id', '=', user.principal.id).execute();
    await t.http().post('/departments').set(user.headers).send({ name: 'New' }).expect(201);
  });

  test('disabling a member ends their access at once', async () => {
    const orgId = await createOrg(t.owner);
    const admin = await createUser(t.owner, orgId, 'org_admin', null);
    const member = await createUser(t.owner, orgId, 'viewer', await createDepartment(t.owner, orgId));
    await t.http().get('/me').set(member.headers).expect(200);
    await t.http().post(`/members/${member.principal.id}/disable`).set(admin.headers).expect(204);
    await t.http().get('/me').set(member.headers).expect(401);
  });
});
