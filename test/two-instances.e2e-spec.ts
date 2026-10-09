import { createTestApp, type TestApp } from './support/app';
import { type Client, connect, eventually, everythingIn, mark, plainText, type } from './support/realtime';
import { type Actor, createDepartment, createDocument, createOrg, createProject, createUser, PASSWORD } from './support/world';

/*
 * Two instances of the API, sharing nothing but the database, as they would behind a load
 * balancer. Each test puts people on different instances and checks they are in the same room:
 * edits, saves, classification, permission changes and sign-outs all cross.
 */

let one: TestApp;
let two: TestApp;
const open: Client[] = [];
beforeAll(async () => { [one, two] = [await createTestApp(), await createTestApp()]; });
afterEach(() => { open.splice(0).forEach((c) => c.destroy()); });
afterAll(async () => { await Promise.all([one.close(), two.close()]); });

async function agency() {
  const orgId = await createOrg(one.owner, 'agency');
  const ops = await createDepartment(one.owner, orgId, 'Operations');
  const director = await createUser(one.owner, orgId, 'org_admin', null, 'director', 3);
  const analyst = await createUser(one.owner, orgId, 'editor', ops, 'analyst', 2);
  const intern = await createUser(one.owner, orgId, 'viewer', ops, 'intern', 0);
  const doc = await createDocument(one.owner, orgId, await createProject(one.owner, orgId, ops), ops, analyst.principal.id);
  const section = (await one.owner.insertInto('document_sections').values({
    org_id: orgId, document_id: doc, position: 1, heading: 'Open', classification: 0, updated_at: new Date(),
  }).returning('id').executeTakeFirstOrThrow()).id;
  return { orgId, director, analyst, intern, doc, section };
}
const on = (app: TestApp, actor: Actor, room: string) => {
  const client = connect(app.url, actor, room);
  open.push(client);
  return client;
};
const stored = async (section: string) => (await one.owner.selectFrom('document_sections').select(['text_length']).where('id', '=', section).executeTakeFirstOrThrow()).text_length;

test('an edit made through one instance reaches a reader on the other, both ways', async () => {
  const a = await agency();
  const analyst = on(one, a.analyst, `section:${a.section}`);
  const director = on(two, a.director, `section:${a.section}`);
  await Promise.all([analyst.ready, director.ready]);
  type(analyst.doc, 'Typed on instance one.');
  await eventually(() => expect(plainText(director.doc)).toBe('Typed on instance one.'));
  type(director.doc, 'Answered on instance two.');
  await eventually(() => expect(plainText(analyst.doc)).toContain('Answered on instance two.'));
});

test('someone who opens the section on the other instance gets what has been typed and not yet saved', async () => {
  const a = await agency();
  const analyst = on(one, a.analyst, `section:${a.section}`);
  await analyst.ready;
  type(analyst.doc, 'Not saved yet.');
  expect(await stored(a.section)).toBe(0); // saving is debounced: the database doesn't have it
  const director = on(two, a.director, `section:${a.section}`);
  await director.ready;
  await eventually(() => expect(plainText(director.doc)).toBe('Not saved yet.'));
});

test('both instances save, and neither save loses the other\'s edits', async () => {
  const a = await agency();
  const analyst = on(one, a.analyst, `section:${a.section}`);
  const director = on(two, a.director, `section:${a.section}`);
  await Promise.all([analyst.ready, director.ready]);
  type(analyst.doc, 'From one.');
  type(director.doc, 'From two.');
  await eventually(() => {
    expect(plainText(analyst.doc)).toContain('From two.');
    expect(plainText(director.doc)).toContain('From one.');
  });
  expect(plainText(analyst.doc)).toBe(plainText(director.doc)); // the same order on both
  await eventually(async () => expect(await stored(a.section)).toBe('From one.'.length + 'From two.'.length), 12000);
  // A third reader, arriving after everyone has saved, reads both from the database.
  const late = on(one, a.intern, `section:${a.section}`);
  await late.ready;
  expect(plainText(late.doc)).toContain('From one.');
  expect(plainText(late.doc)).toContain('From two.');
});

test('a large paste crosses too, though it is too big for a notification', async () => {
  const a = await agency();
  const analyst = on(one, a.analyst, `section:${a.section}`);
  const director = on(two, a.director, `section:${a.section}`);
  await Promise.all([analyst.ready, director.ready]);
  const paste = Array.from({ length: 400 }, (_, i) => `sentence ${i} of a long pasted report.`).join(' ');
  expect(paste.length).toBeGreaterThan(9000);
  type(analyst.doc, paste);
  await eventually(() => expect(plainText(director.doc)).toBe(paste));
});

test('words classified on one instance never reach a reader below them on the other', async () => {
  const a = await agency();
  const director = on(one, a.director, `section:${a.section}`);
  const intern = on(two, a.intern, `section:${a.section}`);
  await Promise.all([director.ready, intern.ready]);
  type(director.doc, 'The contact is known as MERIDIAN.');
  await eventually(() => expect(plainText(intern.doc)).toContain('MERIDIAN')); // unclassified so far: the intern may read it
  // Typed already classified, on instance one. The intern, on instance two, must be gone before it arrives.
  director.doc.transact(() => {
    const paragraph = director.doc.getXmlFragment('default').get(0) as import('yjs').XmlElement;
    (paragraph.get(0) as import('yjs').XmlText).insert(0, 'The deputy minister is the asset. ', { classified: { level: 2 } });
  });
  await eventually(() => expect(intern.closeCodes.length).toBeGreaterThan(0));
  expect(intern.stateless).toContainEqual({ type: 'access', access: 'none' });
  await new Promise((r) => { setTimeout(r, 500); });
  expect(everythingIn(intern.doc)).not.toContain('deputy minister');
  // From now on they are refused the full text on either instance.
  await expect(on(one, a.intern, `section:${a.section}`).ready).rejects.toThrow();
  await expect(on(two, a.intern, `section:${a.section}`).ready).rejects.toThrow();
  mark(director.doc, 'MERIDIAN', 3);
});

test('a demotion requested on one instance takes the pen away on the other', async () => {
  const a = await agency();
  const analyst = on(two, a.analyst, `section:${a.section}`);
  const director = on(one, a.director, `section:${a.section}`);
  await Promise.all([analyst.ready, director.ready]);
  await one.http().patch(`/members/${a.analyst.principal.id}`).set(a.director.headers).send({ role: 'viewer' }).expect(200);
  await eventually(() => expect(analyst.stateless).toContainEqual({ type: 'access', access: 'read' }));
  type(analyst.doc, 'Typed after the demotion');
  await new Promise((r) => { setTimeout(r, 1000); });
  expect(plainText(director.doc)).not.toContain('Typed after the demotion');
});

test('signing out through one instance closes the session\'s connection on the other', async () => {
  const a = await agency();
  const session = (await one.http().post('/auth/login').send({ email: a.analyst.email, password: PASSWORD }).expect(200)).body as { accessToken: string; refreshToken: string };
  const live = on(two, { ...a.analyst, headers: { authorization: `Bearer ${session.accessToken}` } }, `section:${a.section}`);
  await live.ready;
  await one.http().post('/auth/logout').send({ refreshToken: session.refreshToken }).expect(204);
  await eventually(() => expect(live.closeCodes.length).toBeGreaterThan(0));
});
