import { RealtimeService } from '../src/realtime/realtime.service';
import { createTestApp, type TestApp } from './support/app';
import { type Client, connect, eventually, plainText, type } from './support/realtime';
import { createDepartment, createDocument, createOrg, createProject, createUser } from './support/world';

/*
 * The collaboration server, driven by real WebSocket clients: who may join which section, whose
 * edits count, and what happens to connections that are already open when permissions change.
 */

let t: TestApp;
const open: Client[] = [];
beforeAll(async () => { t = await createTestApp(); });
afterEach(() => { open.splice(0).forEach((c) => c.destroy()); });
afterAll(async () => { await t.close(); });

async function agency() {
  const orgId = await createOrg(t.owner, 'agency');
  const [ops, intel] = [await createDepartment(t.owner, orgId, 'Operations'), await createDepartment(t.owner, orgId, 'Intelligence')];
  const director = await createUser(t.owner, orgId, 'org_admin', null, 'director', 3);
  const analyst = await createUser(t.owner, orgId, 'editor', ops, 'analyst', 2);
  const intern = await createUser(t.owner, orgId, 'viewer', ops, 'intern', 0);
  const outsider = await createUser(t.owner, orgId, 'editor', intel, 'outsider', 3);
  const project = await createProject(t.owner, orgId, ops);
  const doc = await createDocument(t.owner, orgId, project, ops, analyst.principal.id);
  const section = async (classification: number) => (await t.owner.insertInto('document_sections').values({
    org_id: orgId, document_id: doc, position: classification + 1, heading: `Level ${classification}`, classification, updated_at: new Date(),
  }).returning('id').executeTakeFirstOrThrow()).id;
  return { orgId, ops, intel, director, analyst, intern, outsider, doc, open: await section(0), secret: await section(2) };
}
const join = (...args: Parameters<typeof connect> extends [string, ...infer R] ? R : never) => {
  const client = connect(t.url, ...args);
  open.push(client);
  return client;
};

test('edits sync between cleared editors, are saved, and are audited', async () => {
  const a = await agency();
  const analyst = join(a.analyst, `section:${a.secret}`);
  const director = join(a.director, `section:${a.secret}`);
  await Promise.all([analyst.ready, director.ready]);
  type(analyst.doc, 'The asset is the deputy minister.');
  await eventually(() => expect(plainText(director.doc)).toBe('The asset is the deputy minister.'));
  await eventually(async () => {
    const row = await t.owner.selectFrom('document_sections').select(['text_length']).where('id', '=', a.secret).executeTakeFirstOrThrow();
    expect(row.text_length).toBe(33);
  }, 10000);
  const events = await t.owner.selectFrom('audit_events').select(['action', 'actor_id']).where('org_id', '=', a.orgId).execute();
  expect(events).toContainEqual({ action: 'section.edit', actor_id: a.analyst.principal.id });
});

test('a member without clearance is refused the section outright; nothing is synced to them', async () => {
  const a = await agency();
  const intern = join(a.intern, `section:${a.secret}`);
  await expect(intern.ready).rejects.toThrow();
  expect(intern.authFailed).toBe(true);
  expect(plainText(intern.doc)).toBe('');
  await join(a.intern, `section:${a.open}`).ready; // the unclassified one is fine
});

test("a reader's edits go nowhere: not to other clients, not to the database", async () => {
  const a = await agency();
  const intern = join(a.intern, `section:${a.open}`);
  const analyst = join(a.analyst, `section:${a.open}`);
  await Promise.all([intern.ready, analyst.ready]);
  type(intern.doc, 'Graffiti');
  type(analyst.doc, 'Official text');
  await eventually(() => expect(plainText(intern.doc)).toContain('Official text'));
  await new Promise((r) => { setTimeout(r, 1500); });
  expect(plainText(analyst.doc)).not.toContain('Graffiti');
});

test('demoted mid-session: the open editor turns read-only at once', async () => {
  const a = await agency();
  const analyst = join(a.analyst, `section:${a.open}`);
  const director = join(a.director, `section:${a.open}`);
  await Promise.all([analyst.ready, director.ready]);
  await t.http().patch(`/members/${a.analyst.principal.id}`).set(a.director.headers).send({ role: 'viewer' }).expect(200);
  await eventually(() => expect(analyst.stateless).toContainEqual({ type: 'access', access: 'read' }));
  type(analyst.doc, 'Typed after the demotion');
  type(director.doc, 'Director still writing');
  await eventually(() => expect(plainText(analyst.doc)).toContain('Director still writing'));
  await new Promise((r) => { setTimeout(r, 1000); });
  expect(plainText(director.doc)).not.toContain('Typed after the demotion');
});

test('clearance lowered mid-session: the member is told and disconnected from the section', async () => {
  const a = await agency();
  const analyst = join(a.analyst, `section:${a.secret}`);
  await analyst.ready;
  await t.http().patch(`/members/${a.analyst.principal.id}`).set(a.director.headers).send({ clearance: 1 }).expect(200);
  await eventually(() => expect(analyst.stateless).toContainEqual({ type: 'access', access: 'none' }));
  await eventually(() => expect(analyst.closeCodes.length).toBeGreaterThan(0));
});

test('a share revoked mid-session closes the guest; a new share lets them in', async () => {
  const a = await agency();
  await join(a.outsider, `section:${a.open}`).ready.catch(() => undefined);
  const share = await t.http().post(`/documents/${a.doc}/shares`).set(a.analyst.headers)
    .send({ subjectType: 'user', subjectId: a.outsider.principal.id, relation: 'editor' }).expect(201);
  const guest = join(a.outsider, `section:${a.open}`);
  await guest.ready;
  await t.http().delete(`/documents/${a.doc}/shares/${share.body.id}`).set(a.analyst.headers).expect(204);
  await eventually(() => expect(guest.stateless).toContainEqual({ type: 'access', access: 'none' }));
  await eventually(() => expect(guest.closeCodes.length).toBeGreaterThan(0));
});

test('the briefing channel tells readers to refresh when the briefing changes', async () => {
  const a = await agency();
  const intern = join(a.intern, `briefing:${a.doc}`);
  await intern.ready;
  await t.http().post(`/documents/${a.doc}/sections`).set(a.analyst.headers).send({ heading: 'New intel', classification: 0 }).expect(201);
  await eventually(() => expect(intern.stateless).toContainEqual({ type: 'refresh' }));
});

test('a personal channel reaches members with no access yet, and only its owner may join', async () => {
  const a = await agency();
  await expect(join(a.analyst, `member:${a.outsider.principal.id}`).ready).rejects.toThrow();
  const mine = join(a.outsider, `member:${a.outsider.principal.id}`);
  await mine.ready;
  await t.http().post(`/documents/${a.doc}/shares`).set(a.analyst.headers)
    .send({ subjectType: 'user', subjectId: a.outsider.principal.id, relation: 'reader' }).expect(201);
  await eventually(() => expect(mine.stateless).toContainEqual({ type: 'refresh' }));
});

test('no edit lands once a demotion has committed, not even one sent the instant the request returns', async () => {
  const a = await agency();
  const analyst = join(a.analyst, `section:${a.open}`);
  const director = join(a.director, `section:${a.open}`);
  await Promise.all([analyst.ready, director.ready]);
  // The Analyst's client doesn't wait to be told: it writes the moment the demotion returns.
  const demoted = t.http().patch(`/members/${a.analyst.principal.id}`).set(a.director.headers).send({ role: 'viewer' });
  await demoted.expect(200);
  type(analyst.doc, 'Sent right after the demotion');
  await new Promise((r) => { setTimeout(r, 1500); });
  expect(plainText(director.doc)).not.toContain('Sent right after the demotion');
  const stored = await t.owner.selectFrom('document_sections').select('text_length').where('id', '=', a.open).executeTakeFirstOrThrow();
  expect(stored.text_length).toBe(0);
});

test('edits refused while access is being re-checked are recovered afterwards: nothing is lost', async () => {
  const a = await agency();
  const analyst = join(a.analyst, `section:${a.open}`);
  const director = join(a.director, `section:${a.open}`);
  await Promise.all([analyst.ready, director.ready]);
  const realtime = t.app.get(RealtimeService);

  // Hold the organization in the fail-closed state a permission change starts with...
  realtime.lock(a.orgId);
  type(director.doc, 'Typed during the lock');
  await new Promise((r) => { setTimeout(r, 500); });
  expect(plainText(analyst.doc)).not.toContain('Typed during the lock'); // refused for now

  // ...then run the re-check: the Director may still edit, so their refused edit is recovered.
  await realtime.refresh(a.orgId);
  await eventually(() => expect(plainText(analyst.doc)).toContain('Typed during the lock'));
});

test('opening a classified section is recorded, once per reader; an unclassified one is not', async () => {
  const a = await agency();
  const reads = async () => (await t.owner.selectFrom('audit_events').select(['actor_id', 'detail']).where('org_id', '=', a.orgId).where('action', '=', 'section.read').orderBy('seq').execute())
    .map((e) => [e.actor_id, e.detail]);
  await join(a.intern, `section:${a.open}`).ready;
  expect(await reads()).toEqual([]);

  await join(a.analyst, `section:${a.secret}`).ready;
  await join(a.analyst, `section:${a.secret}`).ready; // a second tab, or a reconnect
  await join(a.director, `section:${a.secret}`).ready;
  await expect(join(a.intern, `section:${a.secret}`).ready).rejects.toThrow(); // refused: nothing was read
  const full = { section: a.secret, classification: 'secret', view: 'full', markedUpTo: 'unclassified' };
  expect(await reads()).toEqual([[a.analyst.principal.id, full], [a.director.principal.id, full]]);
});

test('bad tokens and unknown rooms are refused', async () => {
  const a = await agency();
  const forged = { ...a.analyst, headers: { authorization: 'Bearer not-a-token' } };
  await expect(join(forged, `section:${a.open}`).ready).rejects.toThrow();
  await expect(join(a.analyst, 'section:not-a-uuid').ready).rejects.toThrow();
  await expect(join(a.analyst, `section:${a.doc}`).ready).rejects.toThrow(); // a document ID is not a section
});
