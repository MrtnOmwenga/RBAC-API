/*
 * The whole authorization model, as data. Every endpoint asks `can()` with an action and the
 * resource it touches; the README's permission table is generated from POLICY, and the e2e suite
 * generates one request per role × action × relationship from it, so code, docs and tests can't
 * drift apart.
 */

export const ROLES = ['org_admin', 'department_admin', 'editor', 'viewer', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that belong to a department; the others act across the whole organization. */
export const DEPARTMENT_ROLES: readonly Role[] = ['department_admin', 'editor', 'viewer'];
export const hasDepartment = (role: Role): boolean => DEPARTMENT_ROLES.includes(role);

export const ACTIONS = [
  'department:create',
  'department:read',
  'member:create',
  'member:read',
  'member:update',
  'member:disable',
  'project:create',
  'project:read',
  'project:update',
  'project:delete',
  'document:create',
  'document:read',
  'document:update',
  'document:delete',
  'api_key:create',
  'api_key:read',
  'api_key:revoke',
  'audit:read',
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * How far a grant reaches: anything in the organization, anything in the principal's own
 * department, or only what the principal created (within their department).
 */
export type Reach = 'org' | 'department' | 'own';

export const POLICY: Record<Action, Partial<Record<Role, Reach>>> = {
  'department:create': { org_admin: 'org' },
  'department:read': { org_admin: 'org', department_admin: 'department', editor: 'department', viewer: 'department', auditor: 'org' },
  'member:create': { org_admin: 'org', department_admin: 'department' },
  'member:read': { org_admin: 'org', department_admin: 'department', auditor: 'org' },
  'member:update': { org_admin: 'org', department_admin: 'department' },
  'member:disable': { org_admin: 'org', department_admin: 'department' },
  'project:create': { org_admin: 'org', department_admin: 'department' },
  'project:read': { org_admin: 'org', department_admin: 'department', editor: 'department', viewer: 'department', auditor: 'org' },
  'project:update': { org_admin: 'org', department_admin: 'department' },
  'project:delete': { org_admin: 'org', department_admin: 'department' },
  'document:create': { org_admin: 'org', department_admin: 'department', editor: 'department' },
  'document:read': { org_admin: 'org', department_admin: 'department', editor: 'department', viewer: 'department', auditor: 'org' },
  'document:update': { org_admin: 'org', department_admin: 'department', editor: 'own' },
  'document:delete': { org_admin: 'org', department_admin: 'department', editor: 'own' },
  'api_key:create': { org_admin: 'org' },
  'api_key:read': { org_admin: 'org', auditor: 'org' },
  'api_key:revoke': { org_admin: 'org' },
  'audit:read': { org_admin: 'org', auditor: 'org' },
};

/**
 * What an integration (API key) may ever be granted. Keys are for machines moving content in and
 * out; people, keys and the audit log stay human-only whatever scopes a key claims.
 */
export const INTEGRATION_ACTIONS: readonly Action[] = ['project:read', 'document:create', 'document:read', 'document:update'];

export type Principal =
  | { kind: 'user'; id: string; orgId: string; role: Role; departmentId: string | null }
  | { kind: 'integration'; id: string; orgId: string; departmentId: string | null; scopes: readonly Action[] };

/** The resource an action touches: the thing itself, or the container a new thing goes into. */
export interface Resource {
  orgId: string;
  departmentId: string | null;
  ownerId?: string | null;
}

/** How far `principal` may perform `action`, or null if not at all. */
export function reachOf(principal: Principal, action: Action): Reach | null {
  if (principal.kind === 'integration') {
    if (!INTEGRATION_ACTIONS.includes(action) || !principal.scopes.includes(action)) return null;
    return principal.departmentId ? 'department' : 'org';
  }
  return POLICY[action][principal.role] ?? null;
}

export function can(principal: Principal, action: Action, resource: Resource): boolean {
  if (principal.orgId !== resource.orgId) return false;
  const reach = reachOf(principal, action);
  if (reach === null) return false;
  if (reach === 'org') return true;
  const sameDepartment = principal.departmentId !== null && principal.departmentId === resource.departmentId;
  if (reach === 'department') return sameDepartment;
  // Only users ever get 'own' reach; the kind check is there for the type system.
  // Stryker disable next-line ConditionalExpression
  return sameDepartment && principal.kind === 'user' && resource.ownerId === principal.id;
}

/**
 * For list endpoints: which rows `principal` may see for `action`. `null` means none; an object
 * with a department ID restricts the query to it; `{}` means the whole organization.
 */
export function listFilter(principal: Principal, action: Action): { departmentId?: string } | null {
  const reach = reachOf(principal, action);
  if (reach === null) return null;
  if (reach === 'org') return {};
  return principal.departmentId ? { departmentId: principal.departmentId } : null;
}

/**
 * Who may give whom which role. Organization admins assign anything; department admins only
 * editors and viewers, only in their own department. Nobody changes their own role (so the last
 * admin can't demote themselves by accident, and nobody can promote themselves).
 */
export function canAssignRole(
  actor: Principal,
  target: { id?: string; role: Role; departmentId: string | null },
): boolean {
  if (actor.kind !== 'user' || actor.id === target.id) return false;
  if (hasDepartment(target.role) !== (target.departmentId !== null)) return false;
  if (actor.role === 'org_admin') return true;
  if (actor.role !== 'department_admin') return false;
  return (target.role === 'editor' || target.role === 'viewer') && target.departmentId === actor.departmentId;
}

/**
 * Who may change or disable an existing member (on top of `member:update` / `member:disable`
 * reach): organization admins anyone but themselves; department admins only the editors and
 * viewers of their own department, so they can't demote a peer or touch organization-wide roles.
 */
export function canManageMember(actor: Principal, target: { id: string; role: Role; departmentId: string | null }): boolean {
  if (actor.kind !== 'user' || actor.id === target.id) return false;
  if (actor.role === 'org_admin') return true;
  return actor.role === 'department_admin'
    && (target.role === 'editor' || target.role === 'viewer')
    && target.departmentId === actor.departmentId;
}
