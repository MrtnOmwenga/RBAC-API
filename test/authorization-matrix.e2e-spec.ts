import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import {
  type Action, ACTIONS, can, canAssignRole, canManageMember, listFilter, type Principal, type Resource,
} from '../src/policy/policy';
import { createTestApp, type TestApp } from './support/app';
import {
  type Actor, createDocument, createKey, createProject, createUser, PASSWORD, seedWorld, type World,
} from './support/world';

/*
 * The authorization matrix, generated: every principal (five roles, three kinds of API key)
 * against every action, on resources in their own department, another department, and another
 * organization. The expected status comes from the policy itself (src/policy/policy.ts), so this
 * proves each endpoint enforces exactly what the policy says:
 *   allowed → the endpoint's success status · denied → 403 · another organization → 404.
 */

type Request = (http: TestApp['http'], actor: Actor) => Promise<Response>;

interface Case {
  request: Request;
  /** The resource the policy is asked about, or 'other-org' for another tenant's resource. */
  resource: Resource | 'other-org';
  /** Checks beyond `can()` that the endpoint must also apply (role assignment rules). */
  extra?: (p: Principal) => boolean;
  success: number;
}

interface Scenario {
  action: Action;
  target: string;
  setup: (w: World, actor: Actor) => Promise<Case>;
}

let t: TestApp;
let w: World;

const org = (w: World, departmentId: string | null): Resource => ({ orgId: w.orgA, departmentId });
const freshEditor = async (w: World, orgId: string, dept: string) => (await createUser(t.owner, orgId, 'editor', dept, 'target')).principal;
/** Someone other than `actor` in department X, to author documents that aren't the actor's. */
const otherAuthorInX = (w: World, actor: Actor) => (actor.principal.id === w.users.deptAdminX.principal.id ? w.users.editorX : w.users.deptAdminX).principal.id;
const authorFor = (w: World, actor: Actor) => (actor.principal.kind === 'user' && actor.principal.departmentId === w.deptX ? actor.principal.id : null);

const inTargets = (action: Action, success: number, make: (w: World, target: 'X' | 'Y' | 'B') => Promise<{ request: Request; extra?: Case['extra'] }>): Scenario[] => (
  (['X', 'Y', 'B'] as const).map((target) => ({
    action,
    target: target === 'B' ? 'another organization' : `department ${target}`,
    setup: async (world) => {
      const made = await make(world, target);
      return { ...made, success, resource: target === 'B' ? 'other-org' : org(world, target === 'X' ? world.deptX : world.deptY) };
    },
  }))
);

const deptOf = (w: World, target: 'X' | 'Y' | 'B') => ({ X: w.deptX, Y: w.deptY, B: w.deptB }[target]);
const orgOf = (w: World, target: 'X' | 'Y' | 'B') => (target === 'B' ? w.orgB : w.orgA);

const documentScenarios = (action: Action, success: number, send: (http: TestApp['http'], id: string, actor: Actor) => Promise<Response>): Scenario[] => [
  {
    action,
    target: 'department X, written by them',
    setup: async (world, actor) => {
      const author = authorFor(world, actor) ?? otherAuthorInX(world, actor);
      const project = await createProject(t.owner, world.orgA, world.deptX);
      const id = await createDocument(t.owner, world.orgA, project, world.deptX, author);
      return { request: (http, a) => send(http, id, a), resource: { ...org(world, world.deptX), ownerId: author }, success };
    },
  },
  {
    action,
    target: 'department X, written by someone else',
    setup: async (world, actor) => {
      const author = otherAuthorInX(world, actor);
      const project = await createProject(t.owner, world.orgA, world.deptX);
      const id = await createDocument(t.owner, world.orgA, project, world.deptX, author);
      return { request: (http, a) => send(http, id, a), resource: { ...org(world, world.deptX), ownerId: author }, success };
    },
  },
  {
    action,
    target: 'department Y',
    setup: async (world) => {
      const project = await createProject(t.owner, world.orgA, world.deptY);
      const id = await createDocument(t.owner, world.orgA, project, world.deptY, world.users.editorY.principal.id);
      return { request: (http, a) => send(http, id, a), resource: { ...org(world, world.deptY), ownerId: world.users.editorY.principal.id }, success };
    },
  },
  {
    action,
    target: 'another organization',
    setup: (world) => Promise.resolve({ request: (http, a) => send(http, world.documentB, a), resource: 'other-org', success }),
  },
];

const as = (req: ReturnType<ReturnType<TestApp['http']>['get']>, actor: Actor) => req.set(actor.headers);

const SCENARIOS: Scenario[] = [
  {
    action: 'department:create',
    target: 'the organization',
    setup: (world) => Promise.resolve({
      request: (http, a) => as(http().post('/departments'), a).send({ name: `d-${randomUUID()}` }), resource: org(world, null), success: 201,
    }),
  },

  ...(['X', 'Y', 'B'] as const).map((target): Scenario => ({
    action: 'member:create',
    target: target === 'B' ? 'another organization' : `an editor in department ${target}`,
    setup: (world) => Promise.resolve({
      request: (http, a) => as(http().post('/members'), a).send({
        email: `new-${randomUUID()}@example.test`, name: 'New', password: PASSWORD, role: 'editor', departmentId: deptOf(world, target),
      }),
      resource: target === 'B' ? 'other-org' : org(world, deptOf(world, target)),
      extra: (p) => canAssignRole(p, { role: 'editor', departmentId: deptOf(world, target) }),
      success: 201,
    }),
  })),
  {
    action: 'member:create',
    target: 'an organization-wide auditor',
    setup: (world) => Promise.resolve({
      request: (http, a) => as(http().post('/members'), a).send({ email: `new-${randomUUID()}@example.test`, name: 'New', password: PASSWORD, role: 'auditor', departmentId: null }),
      resource: org(world, null),
      extra: (p) => canAssignRole(p, { role: 'auditor', departmentId: null }),
      success: 201,
    }),
  },
  ...inTargets('member:read', 200, async (world, target) => {
    const id = await freshEditor(world, orgOf(world, target), deptOf(world, target));
    return { request: (http, a) => as(http().get(`/members/${id.id}`), a) };
  }),
  ...inTargets('member:update', 200, async (world, target) => {
    const member = await freshEditor(world, orgOf(world, target), deptOf(world, target));
    return {
      request: (http, a) => as(http().patch(`/members/${member.id}`), a).send({ role: 'viewer' }),
      extra: (p) => canManageMember(p, { id: member.id, role: 'editor', departmentId: member.departmentId })
        && canAssignRole(p, { id: member.id, role: 'viewer', departmentId: member.departmentId }),
    };
  }),
  ...inTargets('member:disable', 204, async (world, target) => {
    const member = await freshEditor(world, orgOf(world, target), deptOf(world, target));
    return {
      request: (http, a) => as(http().post(`/members/${member.id}/disable`), a),
      extra: (p) => canManageMember(p, { id: member.id, role: 'editor', departmentId: member.departmentId }),
    };
  }),

  ...inTargets('project:create', 201, (world, target) => Promise.resolve({
    request: (http, a) => as(http().post('/projects'), a).send({ name: 'Launch', departmentId: deptOf(world, target) }),
  })),
  ...inTargets('project:read', 200, async (world, target) => {
    const id = await createProject(t.owner, orgOf(world, target), deptOf(world, target));
    return { request: (http, a) => as(http().get(`/projects/${id}`), a) };
  }),
  ...inTargets('project:update', 200, async (world, target) => {
    const id = await createProject(t.owner, orgOf(world, target), deptOf(world, target));
    return { request: (http, a) => as(http().patch(`/projects/${id}`), a).send({ name: 'Renamed' }) };
  }),
  ...inTargets('project:delete', 204, async (world, target) => {
    const id = await createProject(t.owner, orgOf(world, target), deptOf(world, target));
    return { request: (http, a) => as(http().delete(`/projects/${id}`), a) };
  }),

  ...inTargets('document:create', 201, async (world, target) => {
    const project = await createProject(t.owner, orgOf(world, target), deptOf(world, target));
    return { request: (http, a) => as(http().post(`/projects/${project}/documents`), a).send({ title: 'Notes', body: 'Hello' }) };
  }),
  ...documentScenarios('document:read', 200, (http, id, a) => as(http().get(`/documents/${id}`), a)),
  ...documentScenarios('document:update', 200, (http, id, a) => as(http().patch(`/documents/${id}`), a).send({ title: 'Edited' })),
  ...documentScenarios('document:delete', 204, (http, id, a) => as(http().delete(`/documents/${id}`), a)),

  {
    action: 'api_key:create',
    target: 'the organization',
    setup: (world) => Promise.resolve({
      request: (http, a) => as(http().post('/api-keys'), a).send({ name: 'ci', scopes: ['document:read'] }), resource: org(world, null), success: 201,
    }),
  },
  {
    action: 'api_key:revoke',
    target: 'the organization',
    setup: async (world) => {
      const key = await createKey(t.owner, world.orgA, world.users.orgAdmin.principal.id);
      return { request: (http, a) => as(http().delete(`/api-keys/${key.principal.id}`), a), resource: org(world, null), success: 204 };
    },
  },
  {
    action: 'api_key:revoke',
    target: 'another organization',
    setup: async (world) => {
      const key = await createKey(t.owner, world.orgB, world.adminB.principal.id);
      return { request: (http, a) => as(http().delete(`/api-keys/${key.principal.id}`), a), resource: 'other-org', success: 204 };
    },
  },
];

/** List endpoints: allowed principals get 200 and only rows within their reach. */
const LISTS: { action: Action; path: string; departmentOf?: (row: Record<string, unknown>) => unknown }[] = [
  { action: 'department:read', path: '/departments', departmentOf: (r) => r.id },
  { action: 'member:read', path: '/members', departmentOf: (r) => r.departmentId },
  { action: 'project:read', path: '/projects', departmentOf: (r) => r.departmentId },
  { action: 'document:read', path: '/documents', departmentOf: (r) => r.departmentId },
  { action: 'api_key:read', path: '/api-keys' },
  { action: 'audit:read', path: '/audit-events' },
  { action: 'audit:read', path: '/audit-events/verify' },
];

const ACTORS = ['orgAdmin', 'auditor', 'deptAdminX', 'editorX', 'viewerX', 'keyOrgWide', 'keyDeptX', 'keyReadOnly'] as const;
const actor = (name: (typeof ACTORS)[number]): Actor => (name in w.users ? w.users[name as keyof World['users']] : w.keys[name as keyof World['keys']]);

beforeAll(async () => {
  t = await createTestApp();
  w = await seedWorld(t.owner);
  // Give the lists something to filter: content in both departments.
  const projectY = await createProject(t.owner, w.orgA, w.deptY);
  await createDocument(t.owner, w.orgA, projectY, w.deptY, w.users.editorY.principal.id);
});
afterAll(async () => { await t.close(); });

test('every action in the policy is covered by a scenario or a list', () => {
  const covered = new Set([...SCENARIOS.map((s) => s.action), ...LISTS.map((l) => l.action)]);
  expect(ACTIONS.filter((a) => !covered.has(a))).toEqual([]);
});

describe.each(ACTORS)('%s', (name) => {
  test.each(SCENARIOS.map((s) => [s.action, s.target, s] as const))('%s on %s', async (_action, _target, scenario) => {
    const who = actor(name);
    const c = await scenario.setup(w, who);
    let expected = 404;
    if (c.resource !== 'other-org') expected = can(who.principal, scenario.action, c.resource) && (c.extra?.(who.principal) ?? true) ? c.success : 403;
    const res = await c.request(t.http, who);
    expect({ status: res.status, detail: res.body?.detail as unknown }).toMatchObject({ status: expected });
  });

  test.each(LISTS.map((l) => [l.path, l] as const))('lists %s', async (_path, list) => {
    const who = actor(name);
    const filter = listFilter(who.principal, list.action);
    const res = await t.http().get(list.path).set(who.headers);
    if (!filter) {
      expect(res.status).toBe(403);
      return;
    }
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(w.orgB);
    expect(body).not.toContain(w.documentB);
    if (filter.departmentId && list.departmentOf) {
      const departments = new Set((res.body as Record<string, unknown>[]).map(list.departmentOf));
      expect([...departments]).toEqual(departments.size ? [filter.departmentId] : []);
    }
  });
});
