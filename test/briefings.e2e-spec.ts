import { createTestApp, type TestApp } from './support/app';
import { createDepartment, createDocument, createOrg, createProject, createUser, type Actor } from './support/world';

/* Sections, clearance, sharing and "why can I see this?" over the REST API. */

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
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
  const section = async (heading: string, classification: number, text: string) => (await t.owner.insertInto('document_sections').values({
    org_id: orgId, document_id: doc, position: classification + 1, heading, classification, text_length: text.length, updated_at: new Date(),
  }).returning('id').executeTakeFirstOrThrow()).id;
  const sections = {
    open: await section('Cover story', 0, 'A trade conference in Lisbon.'),
    confidential: await section('Contacts', 1, 'Meet the courier at the fish market.'),
    secret: await section('Asset NIGHTJAR', 2, 'The asset is the deputy minister.'),
    topSecret: await section('Exfiltration', 3, 'Submarine pickup at 03:00.'),
  };
  return { orgId, ops, intel, director, analyst, intern, outsider, doc, sections };
}
const briefing = (a: Actor, doc: string) => t.http().get(`/documents/${doc}/briefing`).set(a.headers);

test('each reader sees the sections their clearance allows; the rest are redacted, headings included', async () => {
  const a = await agency();
  const intern = (await briefing(a.intern, a.doc).expect(200)).body;
  expect(intern.access).toBe('read');
  expect(intern.sections.map((s: { access: string }) => s.access)).toEqual(['read', 'none', 'none', 'none']);
  const raw = JSON.stringify(intern);
  for (const hidden of ['Contacts', 'Asset NIGHTJAR', 'Exfiltration']) expect(raw).not.toContain(hidden);
  expect(intern.sections[3]).toEqual({ id: a.sections.topSecret, position: 4, classification: 3, access: 'none', view: 'none', redactedLength: 40 });

  const analyst = (await briefing(a.analyst, a.doc).expect(200)).body;
  expect(analyst.sections.map((s: { access: string }) => s.access)).toEqual(['edit', 'edit', 'edit', 'none']);
  const director = (await briefing(a.director, a.doc).expect(200)).body;
  expect(director.sections.every((s: { heading?: string }) => s.heading)).toBe(true);
});

test('another department sees nothing until the document is shared, then as much as the share says', async () => {
  const a = await agency();
  await briefing(a.outsider, a.doc).expect(403);
  await t.http().get(`/documents/${a.doc}`).set(a.outsider.headers).expect(403);

  const share = await t.http().post(`/documents/${a.doc}/shares`).set(a.analyst.headers)
    .send({ subjectType: 'department', subjectId: a.intel, relation: 'reader' }).expect(201);
  expect((await briefing(a.outsider, a.doc).expect(200)).body.access).toBe('read');
  const listed = await t.http().get('/documents').set(a.outsider.headers).expect(200);
  expect(listed.body.map((d: { id: string }) => d.id)).toContain(a.doc);
  await t.http().patch(`/documents/${a.doc}`).set(a.outsider.headers).send({ title: 'Mine now' }).expect(403);

  await t.http().post(`/documents/${a.doc}/shares`).set(a.analyst.headers)
    .send({ subjectType: 'user', subjectId: a.outsider.principal.id, relation: 'editor' }).expect(201);
  await t.http().patch(`/documents/${a.doc}`).set(a.outsider.headers).send({ title: 'Edited by a guest' }).expect(200);

  await t.http().delete(`/documents/${a.doc}/shares/${share.body.id}`).set(a.analyst.headers).expect(204);
  const grants = await t.http().get(`/documents/${a.doc}/shares`).set(a.analyst.headers).expect(200);
  expect(grants.body).toHaveLength(1);
});

test('a temporary share stops working when it expires', async () => {
  const a = await agency();
  const { body } = await t.http().post(`/documents/${a.doc}/shares`).set(a.analyst.headers)
    .send({ subjectType: 'user', subjectId: a.outsider.principal.id, relation: 'reader', expiresInMinutes: 5 }).expect(201);
  await briefing(a.outsider, a.doc).expect(200);
  await t.owner.updateTable('document_grants').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', body.id).execute();
  await briefing(a.outsider, a.doc).expect(403);
});

test('only people who may share can share, and only with people and departments in their organization', async () => {
  const a = await agency();
  await t.http().post(`/documents/${a.doc}/shares`).set(a.intern.headers).send({ subjectType: 'user', subjectId: a.outsider.principal.id, relation: 'reader' }).expect(403);
  const otherOrg = await createOrg(t.owner);
  const stranger = await createUser(t.owner, otherOrg, 'viewer', await createDepartment(t.owner, otherOrg));
  await t.http().post(`/documents/${a.doc}/shares`).set(a.analyst.headers).send({ subjectType: 'user', subjectId: stranger.principal.id, relation: 'reader' }).expect(404);
  await briefing(stranger, a.doc).expect(404);
});

test('sections can only be created or reclassified within the actor\'s own clearance', async () => {
  const a = await agency();
  await t.http().post(`/documents/${a.doc}/sections`).set(a.analyst.headers).send({ heading: 'Budget', classification: 2 }).expect(201);
  await t.http().post(`/documents/${a.doc}/sections`).set(a.analyst.headers).send({ heading: 'Codes', classification: 3 }).expect(403);
  await t.http().patch(`/sections/${a.sections.secret}`).set(a.analyst.headers).send({ classification: 0 }).expect(204); // declassify what they can read
  await t.http().patch(`/sections/${a.sections.topSecret}`).set(a.analyst.headers).send({ classification: 0 }).expect(403); // not what they can't
  await t.http().patch(`/sections/${a.sections.open}`).set(a.intern.headers).send({ heading: 'Hijacked' }).expect(403);
  await t.http().delete(`/sections/${a.sections.topSecret}`).set(a.analyst.headers).expect(403);
});

test('clearance: set by organization admins, within their own, never their own', async () => {
  const a = await agency();
  await t.http().patch(`/members/${a.intern.principal.id}`).set(a.director.headers).send({ clearance: 2 }).expect(200);
  expect((await briefing(a.intern, a.doc).expect(200)).body.sections.map((s: { access: string }) => s.access)).toEqual(['read', 'read', 'read', 'none']);
  await t.http().patch(`/members/${a.director.principal.id}`).set(a.director.headers).send({ clearance: 0 }).expect(403);
  const deptAdmin = await createUser(t.owner, a.orgId, 'department_admin', a.ops, 'deptAdmin', 3);
  await t.http().patch(`/members/${a.intern.principal.id}`).set(deptAdmin.headers).send({ clearance: 3 }).expect(403);
  const lowAdmin = await createUser(t.owner, a.orgId, 'org_admin', null, 'lowAdmin', 1);
  await t.http().patch(`/members/${a.intern.principal.id}`).set(lowAdmin.headers).send({ clearance: 3 }).expect(403);
});

test('"why can I see this?" lists each reason and what clearance hides', async () => {
  const a = await agency();
  await t.http().post(`/documents/${a.doc}/shares`).set(a.analyst.headers).send({ subjectType: 'user', subjectId: a.intern.principal.id, relation: 'editor' }).expect(201);
  const mine = (await t.http().get(`/documents/${a.doc}/explain`).set(a.intern.headers).expect(200)).body;
  expect(mine.access).toBe('edit');
  expect(mine.reasons.map((r: { source: string; access: string }) => `${r.source}:${r.access}`)).toEqual(['role:read', 'share:edit']);
  expect(mine.redactedSections.map((s: { classification: string }) => s.classification)).toEqual(['confidential', 'secret', 'top_secret']);
  const about = (await t.http().get(`/documents/${a.doc}/explain?userId=${a.outsider.principal.id}`).set(a.director.headers).expect(200)).body;
  expect(about).toMatchObject({ access: 'none', reasons: [] });
  await t.http().get(`/documents/${a.doc}/explain?userId=${a.analyst.principal.id}`).set(a.intern.headers).expect(403);
});

test('every change is in the audit log', async () => {
  const a = await agency();
  await t.http().post(`/documents/${a.doc}/shares`).set(a.analyst.headers).send({ subjectType: 'department', subjectId: a.intel, relation: 'reader' }).expect(201);
  await t.http().patch(`/members/${a.intern.principal.id}`).set(a.director.headers).send({ clearance: 1 }).expect(200);
  const events = await t.owner.selectFrom('audit_events').select(['action', 'detail']).where('org_id', '=', a.orgId).orderBy('seq').execute();
  expect(events.map((e) => e.action)).toEqual(['document.share', 'member.update']);
  expect(events[1]!.detail).toMatchObject({ from: { clearance: 'unclassified' }, to: { clearance: 'confidential' } });
});
