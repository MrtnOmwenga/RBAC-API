import { sql } from 'kysely';
import { createTestApp, type TestApp } from './support/app';
import { createDepartment, createOrg, createUser } from './support/world';

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

test('changes are recorded as a hash chain that verifies; tampering is pinpointed', async () => {
  const orgId = await createOrg(t.owner);
  const admin = await createUser(t.owner, orgId, 'org_admin', null);
  for (const name of ['Sales', 'Support', 'Research']) {
    await t.http().post('/departments').set(admin.headers).send({ name }).expect(201);
  }
  const events = await t.http().get('/audit-events').set(admin.headers).expect(200);
  expect(events.body.map((e: { action: string }) => e.action)).toEqual(['department.create', 'department.create', 'department.create']);
  expect(events.body[0].prevHash).toBe(events.body[1].hash);
  await t.http().get('/audit-events/verify').set(admin.headers).expect(200, { ok: true, events: 3 });

  // Someone with direct database access rewrites history.
  await sql`update audit_events set detail = ${JSON.stringify({ name: 'Nothing to see' })}::jsonb where org_id = ${orgId} and seq = 2`.execute(t.owner);
  const check = await t.http().get('/audit-events/verify').set(admin.headers).expect(200);
  expect(check.body).toMatchObject({ ok: false, brokenAt: 2, reason: 'content does not match its hash' });
});

test('a failed request leaves no audit event behind', async () => {
  const orgId = await createOrg(t.owner);
  const admin = await createUser(t.owner, orgId, 'org_admin', null);
  await t.http().post('/departments').set(admin.headers).send({ name: 'Twice' }).expect(201);
  await t.http().post('/departments').set(admin.headers).send({ name: 'Twice' }).expect(409);
  const rows = await t.owner.selectFrom('audit_events').select('action').where('org_id', '=', orgId).execute();
  expect(rows).toHaveLength(1);
});

test('concurrent changes keep one linear chain', async () => {
  const orgId = await createOrg(t.owner);
  const admin = await createUser(t.owner, orgId, 'org_admin', null);
  await Promise.all(Array.from({ length: 20 }, (_, i) => t.http().post('/departments').set(admin.headers).send({ name: `D${i}` }).expect(201)));
  await t.http().get('/audit-events/verify').set(admin.headers).expect(200, { ok: true, events: 20 });
});

test('auditors read the log; editors cannot', async () => {
  const orgId = await createOrg(t.owner);
  const auditor = await createUser(t.owner, orgId, 'auditor', null);
  const editor = await createUser(t.owner, orgId, 'editor', await createDepartment(t.owner, orgId));
  await t.http().get('/audit-events').set(auditor.headers).expect(200);
  await t.http().get('/audit-events').set(editor.headers).expect(403);
});
