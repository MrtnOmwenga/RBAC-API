import { sql } from 'kysely';
import type { Response } from 'supertest';
import { eventHash, type StoredEvent, verifyChain } from '../src/audit/chain';
import { type Checkpoint, checkpointKey } from '../src/audit/checkpoint';
import { HousekeepingService } from '../src/housekeeping/housekeeping.service';
import { createTestApp, TEST_JWT_SECRET, type TestApp } from './support/app';
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

describe('what the log records beyond changes', () => {
  test('a refused request is recorded, though everything else it did is rolled back', async () => {
    const orgId = await createOrg(t.owner);
    const dept = await createDepartment(t.owner, orgId);
    const admin = await createUser(t.owner, orgId, 'org_admin', null);
    const viewer = await createUser(t.owner, orgId, 'viewer', dept);
    const project = (await t.http().post('/projects').set(admin.headers).send({ name: 'Plans', departmentId: dept }).expect(201)).body.id as string;

    await t.http().delete(`/projects/${project}`).set(viewer.headers).expect(403);
    await t.http().post('/departments').set(viewer.headers).send({ name: 'Mine now' }).expect(403);
    await t.http().get('/audit-events').set(viewer.headers).expect(403);

    const denied = await t.http().get('/audit-events?action=access.denied').set(admin.headers).expect(200);
    expect(denied.body.map((e: StoredEvent) => [e.actorId, e.resourceId, e.detail])).toEqual([
      [viewer.principal.id, null, { method: 'GET', route: '/audit-events', required: 'audit:read', reason: 'Not allowed to audit:read' }],
      [viewer.principal.id, null, { method: 'POST', route: '/departments', required: 'department:create', reason: 'Not allowed to department:create' }],
      [viewer.principal.id, project, { method: 'DELETE', route: '/projects/:id', required: 'project:delete', reason: 'Not allowed to project:delete' }],
    ]);
    // Asking again for what was refused is the same refusal, not a new line each time.
    await t.http().delete(`/projects/${project}`).set(viewer.headers).expect(403);
    expect((await t.http().get('/audit-events?action=access.denied').set(admin.headers).expect(200)).body).toHaveLength(3);
    expect((await t.http().get('/audit-events?exclude=access.denied,project.create').set(admin.headers).expect(200)).body).toEqual([]);
    await t.http().get('/audit-events?exclude=nonsense').set(admin.headers).expect(400);
    // The refusals are links in the same chain as everything else.
    await t.http().get('/audit-events/verify').set(admin.headers).expect(200, { ok: true, events: 4 });
    expect(await t.owner.selectFrom('projects').select('id').where('id', '=', project).executeTakeFirst()).toBeDefined();
  });

  test('an allowed request, a missing resource and a bad request are not refusals', async () => {
    const orgId = await createOrg(t.owner);
    const admin = await createUser(t.owner, orgId, 'org_admin', null);
    await t.http().get('/projects').set(admin.headers).expect(200);
    await t.http().get('/projects/00000000-0000-4000-8000-000000000000').set(admin.headers).expect(404);
    await t.http().post('/departments').set(admin.headers).send({}).expect(400);
    expect((await t.http().get('/audit-events').set(admin.headers).expect(200)).body).toEqual([]);
  });
});

describe('checkpoints: what the chain alone cannot show', () => {
  async function agencyWithHistory() {
    const orgId = await createOrg(t.owner);
    const admin = await createUser(t.owner, orgId, 'org_admin', null);
    for (const name of ['A', 'B', 'C', 'D']) await t.http().post('/departments').set(admin.headers).send({ name }).expect(201);
    const checkpoint = (await t.http().get('/audit-events/checkpoint').set(admin.headers).expect(200)).body as Checkpoint;
    const against = async () => (await t.http().post('/audit-events/verify').set(admin.headers).send({ checkpoint }).expect(200)).body as { ok: boolean; events: number; checkpoint: { ok: boolean; reason?: string } };
    return { orgId, admin, checkpoint, against };
  }

  test('a checkpoint is where the log ends, signed with a key the database does not hold', async () => {
    const a = await agencyWithHistory();
    const last = await t.owner.selectFrom('audit_events').select(['seq', 'hash']).where('org_id', '=', a.orgId).orderBy('seq', 'desc').executeTakeFirstOrThrow();
    expect(a.checkpoint).toMatchObject({ orgId: a.orgId, seq: 4, hash: last.hash });
    const key = (await t.http().get('/audit-events/checkpoint-key').set(a.admin.headers).expect(200)).body as { publicKey: string };
    expect(key.publicKey).toBe(checkpointKey(TEST_JWT_SECRET).publicKey);
    expect(await a.against()).toEqual({ ok: true, events: 4, checkpoint: { ok: true } });
    // The log growing afterwards is fine: the checkpoint's event is still there, unchanged.
    await t.http().post('/departments').set(a.admin.headers).send({ name: 'E' }).expect(201);
    expect(await a.against()).toEqual({ ok: true, events: 5, checkpoint: { ok: true } });
  });

  test('the newest events removed: the chain still verifies, the checkpoint does not', async () => {
    const a = await agencyWithHistory();
    await sql`delete from audit_events where org_id = ${a.orgId} and seq > 2`.execute(t.owner);
    const check = await a.against();
    expect(check).toMatchObject({ ok: true, events: 2 }); // the chain alone sees nothing wrong
    expect(check.checkpoint).toEqual({ ok: false, reason: 'the log no longer has event 4: its newest events were removed' });
  });

  test('history rewritten consistently to the end: the chain still verifies, the checkpoint does not', async () => {
    const a = await agencyWithHistory();
    // Someone with the database changes event 2 and recomputes every hash after it.
    const events = (await t.owner.selectFrom('audit_events').selectAll().where('org_id', '=', a.orgId).orderBy('seq').execute());
    let prev = events[0]!.hash;
    for (const e of events.slice(1)) {
      const content = {
        seq: e.seq, at: e.at.toISOString(), actorType: e.actor_type, actorId: e.actor_id, action: e.action, resourceType: e.resource_type,
        resourceId: e.resource_id, detail: e.seq === 2 ? { name: 'Nothing to see' } : e.detail,
      };
      const hash = eventHash(prev, content);
      await sql`update audit_events set detail = ${JSON.stringify(content.detail)}::jsonb, prev_hash = ${prev}, hash = ${hash} where org_id = ${a.orgId} and seq = ${e.seq}`.execute(t.owner);
      prev = hash;
    }
    const check = await a.against();
    expect(check).toMatchObject({ ok: true, events: 4 });
    expect(check.checkpoint).toEqual({ ok: false, reason: 'event 4 is not the one the checkpoint saw: the log was rewritten' });
  });

  test('a forged checkpoint, and one from another organization, are refused', async () => {
    const a = await agencyWithHistory();
    const b = await agencyWithHistory();
    const send = async (checkpoint: unknown) => t.http().post('/audit-events/verify').set(a.admin.headers).send({ checkpoint });
    expect((await send({ ...a.checkpoint, seq: 2 })).body.checkpoint.ok).toBe(false);
    expect((await send(b.checkpoint)).body.checkpoint).toEqual({ ok: false, reason: 'the checkpoint is for another organization' });
    expect((await send({ ...a.checkpoint, extra: true })).status).toBe(400);
  });

  test('housekeeping writes a checkpoint for each log that grew, to the service\'s log stream', async () => {
    const a = await agencyWithHistory();
    const housekeeping = t.app.get(HousekeepingService);
    const written: Checkpoint[] = [];
    const spy = jest.spyOn((housekeeping as unknown as { checkpoints: { log: (m: unknown) => void } }).checkpoints, 'log')
      .mockImplementation((m) => { written.push((m as { checkpoint: Checkpoint }).checkpoint); });
    Object.assign(housekeeping, { last: Date.now() - 3_600_000 });
    const done = await housekeeping.run();
    spy.mockRestore();
    expect(done.checkpoints).toBe(written.length);
    const mine = written.find((c) => c.orgId === a.orgId)!;
    expect(mine).toMatchObject({ seq: 4, hash: a.checkpoint.hash });
    expect((await t.http().post('/audit-events/verify').set(a.admin.headers).send({ checkpoint: mine }).expect(200)).body.checkpoint).toEqual({ ok: true });
  });
});
