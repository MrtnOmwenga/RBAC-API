import fc from 'fast-check';
import {
  ACTIONS, type Action, can, canAssignRole, canManageMember, DEPARTMENT_ROLES, hasDepartment, INTEGRATION_ACTIONS,
  listFilter, POLICY, type Principal, reachOf, type Resource, type Role, ROLES,
} from './policy';

/*
 * Properties that must hold for every principal and resource, checked against thousands of
 * generated cases. Each one is a security invariant stated once, rather than an example.
 */

const ORGS = ['org-a', 'org-b'];
const DEPTS = ['dept-x', 'dept-y'];
const USERS = ['user-1', 'user-2'];
const MUTATIONS = ACTIONS.filter((a) => !a.endsWith(':read'));
const RUNS = { numRuns: 2000 };

const role = fc.constantFrom(...ROLES);
const action = fc.constantFrom(...ACTIONS);
const user: fc.Arbitrary<Principal> = fc.record({ role, orgId: fc.constantFrom(...ORGS), id: fc.constantFrom(...USERS), dept: fc.constantFrom(...DEPTS) })
  .map(({ role: r, orgId, id, dept }) => ({ kind: 'user' as const, id, orgId, role: r, departmentId: hasDepartment(r) ? dept : null }));
const integration: fc.Arbitrary<Principal> = fc.record({
  orgId: fc.constantFrom(...ORGS), departmentId: fc.constantFrom(null, ...DEPTS), scopes: fc.subarray([...ACTIONS]),
}).map((k) => ({ kind: 'integration' as const, id: 'key-1', ...k }));
const principal = fc.oneof(user, integration);
const resource: fc.Arbitrary<Resource> = fc.record({
  orgId: fc.constantFrom(...ORGS), departmentId: fc.constantFrom(null, ...DEPTS), ownerId: fc.constantFrom(null, ...USERS),
});

describe('invariants', () => {
  test('nothing is ever allowed across organizations', () => {
    fc.assert(fc.property(principal, action, resource, (p, a, r) => {
      fc.pre(p.orgId !== r.orgId);
      expect(can(p, a, r)).toBe(false);
    }), RUNS);
  });

  test('viewers and auditors can never change anything', () => {
    fc.assert(fc.property(user, fc.constantFrom(...MUTATIONS), resource, (p, a, r) => {
      fc.pre(p.kind === 'user' && (p.role === 'viewer' || p.role === 'auditor'));
      expect(can(p, a, r)).toBe(false);
    }), RUNS);
  });

  test('an organization admin can do everything inside their organization', () => {
    fc.assert(fc.property(user, action, resource, (p, a, r) => {
      fc.pre(p.kind === 'user' && p.role === 'org_admin' && p.orgId === r.orgId);
      expect(can(p, a, r)).toBe(true);
    }), RUNS);
  });

  test('department roles never reach another department', () => {
    fc.assert(fc.property(user, action, resource, (p, a, r) => {
      fc.pre(p.kind === 'user' && DEPARTMENT_ROLES.includes(p.role) && r.departmentId !== p.departmentId);
      expect(can(p, a, r)).toBe(false);
    }), RUNS);
  });

  test("'own' grants cover only what the principal created", () => {
    fc.assert(fc.property(user, action, resource, (p, a, r) => {
      fc.pre(reachOf(p, a) === 'own' && r.ownerId !== p.id);
      expect(can(p, a, r)).toBe(false);
    }), RUNS);
  });

  test('an API key never exceeds its scopes or the integration actions, whatever it claims', () => {
    fc.assert(fc.property(integration, action, resource, (p, a, r) => {
      fc.pre(p.kind === 'integration' && can(p, a, r));
      expect(p.kind === 'integration' && p.scopes.includes(a)).toBe(true);
      expect(INTEGRATION_ACTIONS).toContain(a);
    }), RUNS);
  });

  test('list filters agree with can(): a row is listed exactly when it could be fetched', () => {
    fc.assert(fc.property(principal, action, fc.constantFrom(...DEPTS), (p, a, dept) => {
      fc.pre(a.endsWith(':read'));
      const filter = listFilter(p, a);
      const row = { orgId: p.orgId, departmentId: dept, ownerId: null };
      const listed = filter !== null && (filter.departmentId === undefined || filter.departmentId === dept);
      expect(listed).toBe(can(p, a, row));
    }), RUNS);
  });

  test('nobody can assign a role to themselves or create an inconsistent role/department pair', () => {
    fc.assert(fc.property(user, role, fc.constantFrom(null, ...DEPTS), (p, r, dept) => {
      if (p.kind !== 'user') return;
      expect(canAssignRole(p, { id: p.id, role: r, departmentId: dept })).toBe(false);
      if (hasDepartment(r) !== (dept !== null)) expect(canAssignRole(p, { role: r, departmentId: dept })).toBe(false);
    }), RUNS);
  });

  test('a department admin can only ever hand out editor or viewer, in their own department', () => {
    fc.assert(fc.property(user, role, fc.constantFrom(null, ...DEPTS), (p, r, dept) => {
      fc.pre(p.kind === 'user' && p.role === 'department_admin' && canAssignRole(p, { role: r, departmentId: dept }));
      expect(['editor', 'viewer']).toContain(r);
      expect(p.kind === 'user' && dept === p.departmentId).toBe(true);
    }), RUNS);
  });

  test('only organization admins and department admins manage members', () => {
    fc.assert(fc.property(principal, user, (actor, target) => {
      if (target.kind !== 'user') return;
      fc.pre(canManageMember(actor, { id: target.id, role: target.role, departmentId: target.departmentId }));
      expect(actor.kind === 'user' && ['org_admin', 'department_admin'].includes(actor.role)).toBe(true);
      expect(actor.id).not.toBe(target.id);
    }), RUNS);
  });
});

describe('the policy table', () => {
  test('lists every action, and only known roles', () => {
    expect(Object.keys(POLICY).sort()).toEqual([...ACTIONS].sort());
    for (const grants of Object.values(POLICY)) expect(Object.keys(grants).every((r) => ROLES.includes(r as Role))).toBe(true);
  });

  test.each([
    ['editor', 'document:update', { departmentId: 'dept-x', ownerId: 'user-1' }, true],
    ['editor', 'document:update', { departmentId: 'dept-x', ownerId: 'user-2' }, false],
    ['editor', 'document:create', { departmentId: 'dept-x' }, true],
    ['editor', 'project:create', { departmentId: 'dept-x' }, false],
    ['department_admin', 'document:delete', { departmentId: 'dept-x', ownerId: 'user-2' }, true],
    ['department_admin', 'document:delete', { departmentId: 'dept-y', ownerId: 'user-2' }, false],
    ['auditor', 'audit:read', { departmentId: null }, true],
    ['auditor', 'document:read', { departmentId: 'dept-y' }, true],
    ['viewer', 'document:read', { departmentId: 'dept-x' }, true],
    ['viewer', 'member:read', { departmentId: 'dept-x' }, false],
  ] as [Role, Action, Partial<Resource>, boolean][])('%s → %s on %j is %s', (r, a, res, expected) => {
    const p: Principal = { kind: 'user', id: 'user-1', orgId: 'org-a', role: r, departmentId: hasDepartment(r) ? 'dept-x' : null };
    expect(can(p, a, { orgId: 'org-a', departmentId: null, ...res })).toBe(expected);
  });

  test('a department-bound key reaches only its department; an organization key everything in scope', () => {
    const key = (departmentId: string | null): Principal => ({ kind: 'integration', id: 'k', orgId: 'org-a', departmentId, scopes: ['document:read'] });
    expect(can(key('dept-x'), 'document:read', { orgId: 'org-a', departmentId: 'dept-x' })).toBe(true);
    expect(can(key('dept-x'), 'document:read', { orgId: 'org-a', departmentId: 'dept-y' })).toBe(false);
    expect(can(key(null), 'document:read', { orgId: 'org-a', departmentId: 'dept-y' })).toBe(true);
    expect(listFilter(key('dept-x'), 'document:read')).toEqual({ departmentId: 'dept-x' });
    expect(listFilter(key(null), 'document:update')).toBeNull();
  });
});

describe('role assignment and member management', () => {
  const u = (r: Role, id = 'actor', departmentId: string | null = hasDepartment(r) ? 'dept-x' : null): Principal => ({ kind: 'user', id, orgId: 'org-a', role: r, departmentId });
  const key: Principal = { kind: 'integration', id: 'key', orgId: 'org-a', departmentId: null, scopes: [...ACTIONS] };

  test.each([
    ['org_admin', 'department_admin', 'dept-y', true],
    ['org_admin', 'auditor', null, true],
    ['org_admin', 'org_admin', null, true],
    ['department_admin', 'editor', 'dept-x', true],
    ['department_admin', 'viewer', 'dept-x', true],
    ['department_admin', 'viewer', 'dept-y', false],
    ['department_admin', 'department_admin', 'dept-x', false],
    ['department_admin', 'auditor', null, false],
    ['auditor', 'viewer', 'dept-x', false],
    ['editor', 'viewer', 'dept-x', false],
  ] as [Role, Role, string | null, boolean][])('%s assigning %s in %s: %s', (actor, target, dept, expected) => {
    expect(canAssignRole(u(actor), { role: target, departmentId: dept })).toBe(expected);
  });

  test('API keys never assign roles or manage members', () => {
    expect(canAssignRole(key, { role: 'viewer', departmentId: 'dept-x' })).toBe(false);
    expect(canManageMember(key, { id: 'm', role: 'viewer', departmentId: 'dept-x' })).toBe(false);
  });

  test.each([
    ['org_admin', 'department_admin', 'dept-y', true],
    ['org_admin', 'org_admin', null, true],
    ['department_admin', 'editor', 'dept-x', true],
    ['department_admin', 'viewer', 'dept-x', true],
    ['department_admin', 'editor', 'dept-y', false],
    ['department_admin', 'department_admin', 'dept-x', false],
    ['department_admin', 'auditor', null, false],
    ['editor', 'viewer', 'dept-x', false],
    ['auditor', 'viewer', 'dept-x', false],
  ] as [Role, Role, string | null, boolean][])('%s managing a %s in %s: %s', (actor, target, dept, expected) => {
    expect(canManageMember(u(actor), { id: 'member', role: target, departmentId: dept })).toBe(expected);
  });

  test('an own-reach grant still stops at the department boundary, and needs a department', () => {
    const editor = u('editor', 'me');
    expect(can(editor, 'document:update', { orgId: 'org-a', departmentId: 'dept-y', ownerId: 'me' })).toBe(false);
    expect(can(editor, 'document:update', { orgId: 'org-a', departmentId: 'dept-x', ownerId: 'me' })).toBe(true);
    const detached = u('editor', 'me', null); // inconsistent on purpose: the database forbids it
    expect(can(detached, 'document:read', { orgId: 'org-a', departmentId: null })).toBe(false);
    expect(listFilter(detached, 'document:read')).toBeNull();
  });
});
