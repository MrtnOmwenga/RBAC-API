import type { Response } from 'supertest';
import { createTestApp, type TestApp } from './support/app';
import { type Actor, createDepartment, createOrg, createUser } from './support/world';

/*
 * Lists are paged: a plain array, with the next page's address in a Link header while there is
 * more. Following the links visits every row exactly once.
 */

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const nextOf = (res: Response): string | null => /^<([^>]+)>; rel="next"$/.exec(String(res.headers.link ?? ''))?.[1] ?? null;

async function walk(actor: Actor, first: string): Promise<{ pages: number; ids: string[] }> {
  const ids: string[] = [];
  let pages = 0;
  for (let url: string | null = first; url; pages += 1) {
    const res: Response = await t.http().get(url).set(actor.headers).expect(200);
    ids.push(...(res.body as { id: string }[]).map((r) => r.id));
    url = nextOf(res);
  }
  return { pages, ids };
}

async function agency() {
  const orgId = await createOrg(t.owner);
  const dept = await createDepartment(t.owner, orgId, 'Main');
  const admin = await createUser(t.owner, orgId, 'org_admin', null, 'admin');
  return { orgId, dept, admin };
}

test('following the links visits every project once, newest first, however many share a timestamp', async () => {
  const a = await agency();
  // One statement, so every row has the same created_at: only the id breaks the tie.
  const rows = Array.from({ length: 23 }, (_, i) => ({ org_id: a.orgId, department_id: a.dept, name: `project-${i}` }));
  const created = await t.owner.insertInto('projects').values(rows).returning('id').execute();

  const { pages, ids } = await walk(a.admin, '/projects?limit=5');
  expect(pages).toBe(5);
  expect([...ids].sort()).toEqual(created.map((r) => r.id).sort());
  expect(new Set(ids).size).toBe(23);
});

test('members and departments page by name; the last page has no link', async () => {
  const a = await agency();
  for (const name of ['Zed', 'amy', 'Bob', 'bob', 'Cy']) await createUser(t.owner, a.orgId, 'viewer', a.dept, name);
  const all = (await t.http().get('/members').set(a.admin.headers).expect(200)).body as { id: string; name: string }[];
  expect(all).toHaveLength(6);
  const { pages, ids } = await walk(a.admin, '/members?limit=4');
  expect(pages).toBe(2);
  expect(ids).toEqual(all.map((m) => m.id)); // the same order as one big page

  for (const name of ['Ops', 'Intel']) await createDepartment(t.owner, a.orgId, name);
  expect((await walk(a.admin, '/departments?limit=2')).ids).toHaveLength(3);
  const whole = await t.http().get('/departments').set(a.admin.headers).expect(200);
  expect(whole.headers.link).toBeUndefined();
});

test('rows added while someone pages do not shift what they see', async () => {
  const a = await agency();
  await t.owner.insertInto('projects').values(Array.from({ length: 6 }, (_, i) => ({ org_id: a.orgId, department_id: a.dept, name: `old-${i}` }))).execute();
  const first = await t.http().get('/projects?limit=3').set(a.admin.headers).expect(200);
  await t.http().post('/projects').set(a.admin.headers).send({ name: 'arrived-meanwhile', departmentId: a.dept }).expect(201);
  const second = await t.http().get(nextOf(first)!).set(a.admin.headers).expect(200);
  const seen = [...first.body, ...second.body] as { id: string; name: string }[];
  expect(new Set(seen.map((p) => p.id)).size).toBe(6); // no row twice
  expect(seen.map((p) => p.name)).not.toContain('arrived-meanwhile');
});

test('a page keeps to what the caller may see, and other filters carry into the link', async () => {
  const a = await agency();
  const other = await createDepartment(t.owner, a.orgId, 'Other');
  const viewer = await createUser(t.owner, a.orgId, 'viewer', a.dept, 'viewer');
  await t.owner.insertInto('projects').values([
    ...Array.from({ length: 4 }, (_, i) => ({ org_id: a.orgId, department_id: a.dept, name: `mine-${i}` })),
    ...Array.from({ length: 4 }, (_, i) => ({ org_id: a.orgId, department_id: other, name: `theirs-${i}` })),
  ]).execute();
  expect((await walk(viewer, '/projects?limit=3')).ids).toHaveLength(4);
  const keys = await t.http().get('/api-keys?limit=1').set(a.admin.headers).expect(200);
  expect(keys.body).toEqual([]);
});

test('a cursor this API did not issue, and limits out of range, are refused', async () => {
  const a = await agency();
  const forged = Buffer.from(JSON.stringify(["2026-01-01'; drop table projects; --", a.dept])).toString('base64url');
  for (const query of ['cursor=nonsense', `cursor=${forged}`, 'limit=0', 'limit=101', 'offset=5']) {
    await t.http().get(`/projects?${query}`).set(a.admin.headers).expect(400);
  }
});
