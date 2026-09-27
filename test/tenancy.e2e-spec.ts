import { sql } from 'kysely';
import { withTenant } from '../src/database/tenant';
import { createTestApp, type TestApp } from './support/app';
import { createDepartment, createDocument, createOrg, createProject, createUser } from './support/world';

/*
 * Defence in depth: these tests talk to PostgreSQL directly as the API's own role, skipping the
 * application code entirely, to show the database keeps tenants apart even if a query forgets to.
 */

let t: TestApp;
let a: { orgId: string; doc: string };
let b: { orgId: string; doc: string };

async function tenant() {
  const orgId = await createOrg(t.owner);
  const dept = await createDepartment(t.owner, orgId);
  const user = await createUser(t.owner, orgId, 'org_admin', null);
  const project = await createProject(t.owner, orgId, dept);
  return { orgId, dept, user, doc: await createDocument(t.owner, orgId, project, dept, user.principal.id) };
}

beforeAll(async () => {
  t = await createTestApp();
  [a, b] = [await tenant(), await tenant()];
});
afterAll(async () => { await t.close(); });

test('with no organization set, the API role sees nothing at all', async () => {
  for (const table of ['organizations', 'departments', 'users', 'projects', 'documents', 'api_keys', 'refresh_tokens', 'audit_events'] as const) {
    const rows = await t.appDb.selectFrom(table).selectAll().execute();
    expect({ table, rows: rows.length }).toEqual({ table, rows: 0 });
  }
});

test('scoped to one organization, a query without any filter only returns that organization', async () => {
  const docs = await withTenant(t.appDb, a.orgId, (trx) => trx.selectFrom('documents').select(['id', 'org_id']).execute());
  expect(docs.map((d) => d.id)).toContain(a.doc);
  expect(docs.every((d) => d.org_id === a.orgId)).toBe(true);
});

test("writing into another organization's rows is refused by the database", async () => {
  await expect(withTenant(t.appDb, a.orgId, (trx) => trx.insertInto('departments').values({ org_id: b.orgId, name: 'smuggled' }).execute()))
    .rejects.toThrow(/row-level security/);
  const updated = await withTenant(t.appDb, a.orgId, (trx) => trx.updateTable('documents').set({ title: 'hijacked' }).where('id', '=', b.doc).executeTakeFirst());
  expect(Number(updated.numUpdatedRows)).toBe(0);
});

test('the API role cannot change or erase the audit log', async () => {
  await t.http().post('/departments').set((await createUser(t.owner, a.orgId, 'org_admin', null)).headers).send({ name: 'Audited' }).expect(201);
  await expect(withTenant(t.appDb, a.orgId, (trx) => trx.updateTable('audit_events').set({ action: 'forged' }).execute())).rejects.toThrow(/permission denied/);
  await expect(withTenant(t.appDb, a.orgId, (trx) => trx.deleteFrom('audit_events').execute())).rejects.toThrow(/permission denied/);
});

test('login lookups return only IDs, and raw queries as the API role still see no rows', async () => {
  const { rows } = await sql<Record<string, unknown>>`select * from auth_login_lookup('nobody@example.test')`.execute(t.appDb);
  expect(rows).toEqual([]);
  await expect(sql`select * from users`.execute(t.appDb)).resolves.toMatchObject({ rows: [] });
});

test('over HTTP, another organization\'s IDs are simply not found', async () => {
  const intruder = await createUser(t.owner, a.orgId, 'org_admin', null);
  await t.http().get(`/documents/${b.doc}`).set(intruder.headers).expect(404);
  await t.http().delete(`/documents/${b.doc}`).set(intruder.headers).expect(404);
  const stillThere = await t.owner.selectFrom('documents').select('id').where('id', '=', b.doc).executeTakeFirst();
  expect(stillThere).toBeDefined();
});
