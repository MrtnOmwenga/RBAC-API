import { sql } from 'kysely';
import type { Response } from 'supertest';
import { type StoredEvent, verifyChain } from '../src/audit/chain';
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

describe('finding things in the log', () => {
  async function busyAgency() {
    const orgId = await createOrg(t.owner);
    const admin = await createUser(t.owner, orgId, 'org_admin', null, 'admin');
    const second = await createUser(t.owner, orgId, 'org_admin', null, 'second');
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C', 'D', 'E']) ids.push((await t.http().post('/departments').set(admin.headers).send({ name }).expect(201)).body.id as string);
    await t.http().post('/projects').set(second.headers).send({ name: 'P', departmentId: ids[0] }).expect(201);
    await t.http().post('/api-keys').set(second.headers).send({ name: 'k', scopes: ['document:read'] }).expect(201);
    return { orgId, admin, second, ids };
  }
  const actions = (res: { body: { action: string }[] }) => res.body.map((e) => e.action);

  test('by member, by action or family of actions, by resource, by time', async () => {
    const a = await busyAgency();
    const get = (query: string) => t.http().get(`/audit-events?${query}`).set(a.admin.headers).expect(200);
    expect(actions(await get(`actorId=${a.second.principal.id}`))).toEqual(['api_key.create', 'project.create']);
    expect(actions(await get('action=project.create'))).toEqual(['project.create']);
    expect(actions(await get('action=department.'))).toHaveLength(5);
    expect(actions(await get('action=project.'))).toEqual(['project.create']); // a family, not "anything starting with p"
    expect((await get(`resourceId=${a.ids[2]}`)).body).toHaveLength(1);
    expect((await get(`from=${new Date(Date.now() + 60_000).toISOString()}`)).body).toEqual([]);
    expect((await get(`to=${new Date(Date.now() + 60_000).toISOString()}`)).body).toHaveLength(7);
    // "%" and "_" mean themselves, and nothing unexpected is accepted.
    await t.http().get('/audit-events?action=%25.').set(a.admin.headers).expect(400);
    await t.http().get('/audit-events?actorId=not-an-id').set(a.admin.headers).expect(400);
  });

  test('older pages follow from a link, newest first, each event once', async () => {
    const a = await busyAgency();
    const first = await t.http().get('/audit-events?limit=3').set(a.admin.headers).expect(200);
    expect(first.body.map((e: { seq: number }) => e.seq)).toEqual([7, 6, 5]);
    const next = /^<([^>]+)>; rel="next"$/.exec(first.headers.link as string)![1]!;
    expect(next).toBe('/audit-events?limit=3&before=5');
    const second = await t.http().get(next).set(a.admin.headers).expect(200);
    expect(second.body.map((e: { seq: number }) => e.seq)).toEqual([4, 3, 2]);
  });

  test('the export is the whole chain, oldest first, and verifies on its own', async () => {
    const a = await busyAgency();
    const lines: StoredEvent[] = [];
    let url: string | null = '/audit-events/export?limit=3';
    let pages = 0;
    for (; url; pages += 1) {
      const res: Response = await t.http().get(url).set(a.admin.headers).buffer(true).parse((r, done) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => { text += chunk; });
        r.on('end', () => done(null, text));
      }).expect(200);
      expect(res.headers['content-type']).toMatch(/^application\/x-ndjson/);
      expect(res.headers['content-disposition']).toContain('audit-events.ndjson');
      lines.push(...(res.body as string).trimEnd().split('\n').map((l) => JSON.parse(l) as StoredEvent));
      url = /^<([^>]+)>; rel="next"$/.exec((res.headers.link) ?? '')?.[1] ?? null;
    }
    expect(pages).toBe(3);
    expect(lines.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Checked with the chain code alone: no API, no database.
    expect(verifyChain(a.orgId, lines)).toEqual({ ok: true, events: 7 });
    lines[3]!.detail = { name: 'edited in the file' };
    expect(verifyChain(a.orgId, lines)).toMatchObject({ ok: false, brokenAt: 4 });
  });

  test('the export is for those who may read the log', async () => {
    const a = await busyAgency();
    const editor = await createUser(t.owner, a.orgId, 'editor', a.ids[0]!);
    await t.http().get('/audit-events/export').set(editor.headers).expect(403);
  });
});
