import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { hashPassword } from '../../src/auth/passwords';
import { newApiKey, signAccessToken } from '../../src/auth/tokens';
import type { Database } from '../../src/database/schema';
import { type Action, INTEGRATION_ACTIONS, type Principal, type Role } from '../../src/policy/policy';
import { TEST_JWT_SECRET } from './app';

export const PASSWORD = 'correct horse battery staple';
let passwordHash: Promise<string> | undefined;
const hashed = () => (passwordHash ??= hashPassword(PASSWORD));

export interface Actor {
  name: string;
  principal: Principal;
  headers: Record<string, string>;
  email?: string;
}

/*
 * Seeds straight into the database as the owner: fast, and independent of the API under test.
 * Every organization gets unique names, so tests can share a database without cleaning up.
 */

export async function createOrg(owner: Kysely<Database>, label = 'org') {
  const orgId = randomUUID();
  await owner.insertInto('organizations').values({ id: orgId, name: `${label}-${orgId.slice(0, 8)}` }).execute();
  return orgId;
}

export async function createDepartment(owner: Kysely<Database>, orgId: string, name = `dept-${randomUUID().slice(0, 8)}`) {
  const row = await owner.insertInto('departments').values({ org_id: orgId, name }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

export async function createUser(owner: Kysely<Database>, orgId: string, role: Role, departmentId: string | null, name: string = role): Promise<Actor> {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
  const row = await owner.insertInto('users').values({
    org_id: orgId, email, name, password_hash: await hashed(), role, department_id: departmentId,
  }).returning('id').executeTakeFirstOrThrow();
  return {
    name,
    email,
    principal: { kind: 'user', id: row.id, orgId, role, departmentId },
    headers: { authorization: `Bearer ${signAccessToken(TEST_JWT_SECRET, 900, { userId: row.id, orgId })}` },
  };
}

export async function createKey(
  owner: Kysely<Database>, orgId: string, createdBy: string,
  options: { name?: string; scopes?: readonly Action[]; departmentId?: string | null; expiresAt?: Date | null } = {},
): Promise<Actor> {
  const { key, prefix, secretHash } = newApiKey();
  const scopes = [...(options.scopes ?? INTEGRATION_ACTIONS)];
  const row = await owner.insertInto('api_keys').values({
    org_id: orgId, name: options.name ?? 'integration', prefix, secret_hash: secretHash, scopes,
    department_id: options.departmentId ?? null, created_by: createdBy, expires_at: options.expiresAt ?? null,
  }).returning('id').executeTakeFirstOrThrow();
  return {
    name: options.name ?? 'integration',
    principal: { kind: 'integration', id: row.id, orgId, departmentId: options.departmentId ?? null, scopes },
    headers: { 'x-api-key': key },
  };
}

export async function createProject(owner: Kysely<Database>, orgId: string, departmentId: string) {
  const row = await owner.insertInto('projects').values({ org_id: orgId, department_id: departmentId, name: `project-${randomUUID().slice(0, 8)}` })
    .returning('id').executeTakeFirstOrThrow();
  return row.id;
}

export async function createDocument(owner: Kysely<Database>, orgId: string, projectId: string, departmentId: string, authorId: string) {
  const row = await owner.insertInto('documents').values({
    org_id: orgId, project_id: projectId, department_id: departmentId, title: 'A document', body: 'Body', author_id: authorId, api_key_id: null, updated_at: new Date(),
  }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

/**
 * Organization A: departments X and Y, one member of every role, three API keys. Organization B:
 * one department, an admin, a project and a document, for cross-tenant attempts.
 */
export async function seedWorld(owner: Kysely<Database>) {
  const orgA = await createOrg(owner, 'acme');
  const [deptX, deptY] = [await createDepartment(owner, orgA, 'X'), await createDepartment(owner, orgA, 'Y')];
  const orgAdmin = await createUser(owner, orgA, 'org_admin', null);
  const users = {
    orgAdmin,
    auditor: await createUser(owner, orgA, 'auditor', null),
    deptAdminX: await createUser(owner, orgA, 'department_admin', deptX, 'deptAdminX'),
    editorX: await createUser(owner, orgA, 'editor', deptX, 'editorX'),
    viewerX: await createUser(owner, orgA, 'viewer', deptX, 'viewerX'),
    editorY: await createUser(owner, orgA, 'editor', deptY, 'editorY'),
  };
  const keys = {
    keyOrgWide: await createKey(owner, orgA, orgAdmin.principal.id, { name: 'keyOrgWide' }),
    keyDeptX: await createKey(owner, orgA, orgAdmin.principal.id, { name: 'keyDeptX', departmentId: deptX }),
    keyReadOnly: await createKey(owner, orgA, orgAdmin.principal.id, { name: 'keyReadOnly', scopes: ['document:read'] }),
  };
  const orgB = await createOrg(owner, 'globex');
  const deptB = await createDepartment(owner, orgB, 'B');
  const adminB = await createUser(owner, orgB, 'org_admin', null, 'adminB');
  const projectB = await createProject(owner, orgB, deptB);
  const documentB = await createDocument(owner, orgB, projectB, deptB, adminB.principal.id);
  return { orgA, deptX, deptY, users, keys, orgB, deptB, adminB, projectB, documentB };
}

export type World = Awaited<ReturnType<typeof seedWorld>>;
