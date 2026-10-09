import { signAccessToken } from '../src/auth/tokens';
import { createTestApp, TEST_JWT_SECRET, type TestApp } from './support/app';
import { type Client, connect, eventually } from './support/realtime';
import { type Actor, createDepartment, createDocument, createOrg, createProject, createUser, PASSWORD } from './support/world';

/*
 * Open connections losing access with no permission change to announce: a temporary share runs
 * out, a token expires, a member signs out. The sweep runs every second here.
 */

let t: TestApp;
const open: Client[] = [];
beforeAll(async () => { t = await createTestApp({ REALTIME_SWEEP_SECONDS: '1' }); });
afterEach(() => { open.splice(0).forEach((c) => c.destroy()); });
afterAll(async () => { await t.close(); });

async function agency() {
  const orgId = await createOrg(t.owner, 'agency');
  const [ops, intel] = [await createDepartment(t.owner, orgId, 'Operations'), await createDepartment(t.owner, orgId, 'Intelligence')];
  const analyst = await createUser(t.owner, orgId, 'editor', ops, 'analyst', 2);
  const outsider = await createUser(t.owner, orgId, 'editor', intel, 'outsider', 3);
  const doc = await createDocument(t.owner, orgId, await createProject(t.owner, orgId, ops), ops, analyst.principal.id);
  const section = (await t.owner.insertInto('document_sections').values({
    org_id: orgId, document_id: doc, position: 1, heading: 'Open', classification: 0, updated_at: new Date(),
  }).returning('id').executeTakeFirstOrThrow()).id;
  return { orgId, analyst, outsider, doc, section };
}
const join = (actor: Actor, room: string) => {
  const client = connect(t.url, actor, room);
  open.push(client);
  return client;
};
const closed = (client: Client) => eventually(() => {
  expect(client.stateless).toContainEqual({ type: 'access', access: 'none' });
  expect(client.closeCodes.length).toBeGreaterThan(0);
}, 8000);
const stillOpen = async (client: Client) => {
  await new Promise((r) => { setTimeout(r, 2500); });
  expect(client.closeCodes).toEqual([]);
};

test('a temporary share that runs out closes the guest, with nobody changing anything', async () => {
  const a = await agency();
  await t.http().post(`/documents/${a.doc}/shares`).set(a.analyst.headers)
    .send({ subjectType: 'user', subjectId: a.outsider.principal.id, relation: 'editor', expiresInMinutes: 60 }).expect(201);
  const guest = join(a.outsider, `section:${a.section}`);
  const host = join(a.analyst, `section:${a.section}`);
  await Promise.all([guest.ready, host.ready]);
  // The share's last second arrives.
  await t.owner.updateTable('document_grants').set({ expires_at: new Date(Date.now() + 1500) }).where('document_id', '=', a.doc).execute();
  await closed(guest);
  expect(host.closeCodes).toEqual([]); // the member who shared it is untouched
});

test('a connection ends when the token that opened it expires', async () => {
  const a = await agency();
  const shortLived = { ...a.analyst, headers: { authorization: `Bearer ${signAccessToken(TEST_JWT_SECRET, 2, { userId: a.analyst.principal.id, orgId: a.orgId })}` } };
  const expiring = join(shortLived, `section:${a.section}`);
  const lasting = join(a.analyst, `section:${a.section}`);
  await Promise.all([expiring.ready, lasting.ready]);
  await closed(expiring);
  expect(lasting.closeCodes).toEqual([]);
});

test("signing out closes that session's connections and leaves the member's other session open", async () => {
  const a = await agency();
  const login = async () => (await t.http().post('/auth/login').send({ email: a.analyst.email, password: PASSWORD }).expect(200)).body as { accessToken: string; refreshToken: string };
  const [laptop, phone] = [await login(), await login()];
  const as = (session: { accessToken: string }) => ({ ...a.analyst, headers: { authorization: `Bearer ${session.accessToken}` } });
  const onLaptop = join(as(laptop), `section:${a.section}`);
  const onPhone = join(as(phone), `section:${a.section}`);
  await Promise.all([onLaptop.ready, onPhone.ready]);
  await t.http().post('/auth/logout').send({ refreshToken: laptop.refreshToken }).expect(204);
  await closed(onLaptop);
  await stillOpen(onPhone);
});
