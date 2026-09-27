import { createTestApp, type TestApp } from './support/app';
import { createDepartment, createKey, createOrg, createProject, createUser, PASSWORD } from './support/world';

/* Attempts to gain more than the policy grants: through the request body, through role
 * assignment, or by stretching an API key's scopes. */

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

async function org() {
  const orgId = await createOrg(t.owner);
  const [x, y] = [await createDepartment(t.owner, orgId), await createDepartment(t.owner, orgId)];
  return {
    orgId, x, y,
    admin: await createUser(t.owner, orgId, 'org_admin', null),
    deptAdmin: await createUser(t.owner, orgId, 'department_admin', x),
    editor: await createUser(t.owner, orgId, 'editor', x),
  };
}

test('fields the client may not set are rejected, not ignored (mass assignment)', async () => {
  const o = await org();
  const project = await createProject(t.owner, o.orgId, o.x);
  await t.http().post(`/projects/${project}/documents`).set(o.editor.headers).send({ title: 'T', body: 'B', authorId: o.admin.principal.id }).expect(400);
  await t.http().post('/projects').set(o.deptAdmin.headers).send({ name: 'P', departmentId: o.x, orgId: o.orgId }).expect(400);
  await t.http().patch(`/documents/${project}`).set(o.editor.headers).send({ departmentId: o.y }).expect(400);
});

test('a department admin cannot create or promote beyond editor, or reach another department', async () => {
  const o = await org();
  const create = (role: string, departmentId: string | null) => t.http().post('/members').set(o.deptAdmin.headers)
    .send({ email: `m-${Math.random()}@example.test`, name: 'M', password: PASSWORD, role, departmentId });
  await create('editor', o.x).expect(201);
  await create('department_admin', o.x).expect(403);
  await create('org_admin', null).expect(403);
  await create('editor', o.y).expect(403);

  const viewer = await createUser(t.owner, o.orgId, 'viewer', o.x);
  await t.http().patch(`/members/${viewer.principal.id}`).set(o.deptAdmin.headers).send({ role: 'department_admin' }).expect(403);
  await t.http().patch(`/members/${viewer.principal.id}`).set(o.deptAdmin.headers).send({ departmentId: o.y }).expect(403);
  await t.http().patch(`/members/${viewer.principal.id}`).set(o.deptAdmin.headers).send({ role: 'editor' }).expect(200);
});

test('nobody changes or disables their own account, admins included', async () => {
  const o = await org();
  await t.http().patch(`/members/${o.admin.principal.id}`).set(o.admin.headers).send({ role: 'auditor' }).expect(403);
  await t.http().post(`/members/${o.admin.principal.id}/disable`).set(o.admin.headers).expect(403);
  await t.http().patch(`/members/${o.deptAdmin.principal.id}`).set(o.deptAdmin.headers).send({ role: 'editor' }).expect(403);
});

test('a department admin cannot touch a peer department admin', async () => {
  const o = await org();
  const peer = await createUser(t.owner, o.orgId, 'department_admin', o.x);
  await t.http().post(`/members/${peer.principal.id}/disable`).set(o.deptAdmin.headers).expect(403);
});

test('a role must match its department: no department roles without one, no org roles with one', async () => {
  const o = await org();
  const create = (role: string, departmentId: string | null) => t.http().post('/members').set(o.admin.headers)
    .send({ email: `m-${Math.random()}@example.test`, name: 'M', password: PASSWORD, role, departmentId });
  await create('editor', null).expect(403);
  await create('auditor', o.x).expect(403);
});

test('API keys can only hold integration scopes, and only use the ones they hold', async () => {
  const o = await org();
  const create = (scopes: string[]) => t.http().post('/api-keys').set(o.admin.headers).send({ name: 'k', scopes });
  await create(['member:create']).expect(400);
  await create(['audit:read']).expect(400);
  await create(['document:read', 'document:read']).expect(400);
  const created = await create(['document:read']).expect(201);
  const headers = { 'x-api-key': created.body.key as string };
  const project = await createProject(t.owner, o.orgId, o.x);
  await t.http().get('/documents').set(headers).expect(200);
  await t.http().post(`/projects/${project}/documents`).set(headers).send({ title: 'T', body: 'B' }).expect(403);
  await t.http().get('/members').set(headers).expect(403);
  await t.http().post('/api-keys').set(headers).send({ name: 'escalate', scopes: ['document:create'] }).expect(403);
});

test('a department-bound key stays in its department', async () => {
  const o = await org();
  const key = await createKey(t.owner, o.orgId, o.admin.principal.id, { departmentId: o.x });
  const [px, py] = [await createProject(t.owner, o.orgId, o.x), await createProject(t.owner, o.orgId, o.y)];
  await t.http().post(`/projects/${px}/documents`).set(key.headers).send({ title: 'T', body: 'B' }).expect(201);
  await t.http().post(`/projects/${py}/documents`).set(key.headers).send({ title: 'T', body: 'B' }).expect(403);
});
