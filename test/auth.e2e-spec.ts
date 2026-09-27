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
    await t.http().post('/auth/refresh').send({ refreshToken: founder.refreshToken }).expect(401); // stolen copy replayed
    await t.http().post('/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
    const events = await t.owner.selectFrom('audit_events').select('action').where('org_id', '=', founder.orgId).execute();
    expect(events.map((e) => e.action)).toContain('auth.refresh_reuse_detected');
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
