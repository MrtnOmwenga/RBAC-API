import { maxMarkLevel } from '../src/realtime/projection';
import { RealtimeService } from '../src/realtime/realtime.service';
import { createTestApp, type TestApp } from './support/app';
import {
  type Client, connect, eventually, everythingIn, mark, plainText, sectionWithMarks, type, typeClassified,
} from './support/realtime';
import { createDepartment, createDocument, createOrg, createProject, createUser } from './support/world';

/*
 * Word-level classification: "mark to classify, project to read" (docs/COLLABORATION.md). The full
 * text of a section goes only to members cleared for every word marked in it; everyone else reads
 * a projection the server derives at their clearance, with the words above it replaced by bars.
 */

let t: TestApp;
const open: Client[] = [];
beforeAll(async () => { t = await createTestApp(); });
afterEach(() => { open.splice(0).forEach((c) => c.destroy()); });
afterAll(async () => { await t.close(); });

async function agency() {
  const orgId = await createOrg(t.owner, 'agency');
  const ops = await createDepartment(t.owner, orgId, 'Operations');
  const director = await createUser(t.owner, orgId, 'org_admin', null, 'director', 3);
  const analyst = await createUser(t.owner, orgId, 'editor', ops, 'analyst', 2);
  const intern = await createUser(t.owner, orgId, 'viewer', ops, 'intern', 0);
  const project = await createProject(t.owner, orgId, ops);
  const doc = await createDocument(t.owner, orgId, project, ops, analyst.principal.id);
  const { state, length, marked } = sectionWithMarks([[['Courier ', 0], ['MERIDIAN', 2], [' waits at the fish market.', 0]]]);
  const section = (await t.owner.insertInto('document_sections').values({
    org_id: orgId, document_id: doc, position: 1, heading: 'Contacts', classification: 0, state, text_length: length, max_mark_level: marked, updated_at: new Date(),
  }).returning('id').executeTakeFirstOrThrow()).id;
  return { orgId, director, analyst, intern, doc, section };
}
const join = (...args: Parameters<typeof connect> extends [string, ...infer R] ? R : never) => {
  const client = connect(t.url, ...args);
  open.push(client);
  return client;
};

test('below the marks, the full text is refused and the projection shows bars; the hidden words are never sent', async () => {
  const a = await agency();
  await expect(join(a.intern, `section:${a.section}`).ready).rejects.toThrow();
  await expect(join(a.intern, `projection:${a.section}:2`).ready).rejects.toThrow(); // not above their own clearance

  const intern = join(a.intern, `projection:${a.section}:0`);
  await intern.ready;
  await eventually(() => expect(plainText(intern.doc)).toBe('Courier ████████████ waits at the fish market.'));
  expect(everythingIn(intern.doc)).not.toContain('MERIDIAN');

  const briefing = (await t.http().get(`/documents/${a.doc}/briefing`).set(a.intern.headers).expect(200)).body;
  expect(briefing.sections[0]).toMatchObject({ view: 'projection', projectionLevel: 0, access: 'read', heading: 'Contacts' });
  const analyst = (await t.http().get(`/documents/${a.doc}/briefing`).set(a.analyst.headers).expect(200)).body;
  expect(analyst.sections[0]).toMatchObject({ view: 'full', access: 'edit' });
});

test('the projection follows edits to the full text live', async () => {
  const a = await agency();
  const analyst = join(a.analyst, `section:${a.section}`);
  const intern = join(a.intern, `projection:${a.section}:0`);
  await Promise.all([analyst.ready, intern.ready]);
  type(analyst.doc, 'Bring cash.');
  await eventually(() => expect(plainText(intern.doc)).toContain('Bring cash.'));
  expect(everythingIn(intern.doc)).not.toContain('MERIDIAN');
});

test('marking words above a connected editor\'s clearance disconnects them before anything more reaches them', async () => {
  const a = await agency();
  const director = join(a.director, `section:${a.section}`);
  const analyst = join(a.analyst, `section:${a.section}`);
  await Promise.all([director.ready, analyst.ready]);

  // The background re-check would also disconnect them, a few milliseconds later. Switch it off
  // here, so this proves the check that runs *before* the update is applied is enough on its own.
  const recheck = jest.spyOn(t.app.get(RealtimeService), 'refresh').mockResolvedValue(undefined);
  try {
    // Mark, and keep typing inside the new classification straight away, without waiting.
    mark(director.doc, 'fish market', 3);
    typeClassified(director.doc, 'fish market', ' Pickup at 03:00.', 3);
    await eventually(() => expect(analyst.stateless).toContainEqual({ type: 'access', access: 'none' }));
    await new Promise((r) => { setTimeout(r, 800); });
    expect(everythingIn(analyst.doc)).not.toContain('03:00');
  } finally {
    recheck.mockRestore();
  }

  // Their page now reads the projection at their level: the newly marked words are bars.
  const projection = join(a.analyst, `projection:${a.section}:2`);
  await projection.ready;
  await eventually(() => expect(plainText(projection.doc)).toMatch(/^Courier MERIDIAN waits at the █+\.█+$/));
  expect(everythingIn(projection.doc)).not.toContain('03:00');
});

test('nobody can mark words above their own clearance: the update is refused and the connection closed', async () => {
  const a = await agency();
  const analyst = join(a.analyst, `section:${a.section}`);
  const director = join(a.director, `section:${a.section}`);
  await Promise.all([analyst.ready, director.ready]);
  mark(analyst.doc, 'Courier', 3);
  await eventually(() => expect(analyst.closeCodes.length).toBeGreaterThan(0));
  await new Promise((r) => { setTimeout(r, 500); });
  expect(maxMarkLevel(director.doc.getXmlFragment('default'))).toBe(2);
});

test('marks are saved with the section and audited', async () => {
  const a = await agency();
  const director = join(a.director, `section:${a.section}`);
  await director.ready;
  mark(director.doc, 'Courier', 3);
  await eventually(async () => {
    const row = await t.owner.selectFrom('document_sections').select('max_mark_level').where('id', '=', a.section).executeTakeFirstOrThrow();
    expect(row.max_mark_level).toBe(3);
  }, 10000);
  const events = await t.owner.selectFrom('audit_events').select(['action', 'detail']).where('org_id', '=', a.orgId).execute();
  expect(events).toContainEqual({ action: 'section.edit', detail: expect.objectContaining({ marked: { from: 'secret', to: 'top_secret' } }) });
});
