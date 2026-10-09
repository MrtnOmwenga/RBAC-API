import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { ANY_PRINCIPAL, IS_PUBLIC, REQUIRES } from '../src/common/http';
import { ACTIONS } from '../src/policy/policy';
import { DocumentsService } from '../src/documents/documents.service';
import { createTestApp, type TestApp } from './support/app';
import { createDepartment, createDocument, createOrg, createProject, createUser } from './support/world';

/*
 * No endpoint can forget to ask. Every route says which action it needs, and a request that
 * finishes without the policy having been asked about that action fails and writes nothing.
 */

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

interface Route { name: string; declared: unknown; isPublic: boolean }

function routes(): Route[] {
  const found: Route[] = [];
  for (const module of t.app.get(ModulesContainer).values()) {
    for (const { instance, metatype } of module.controllers.values()) {
      if (!metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, (...args: unknown[]) => unknown>;
      for (const method of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[method]!;
        if (method === 'constructor' || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBeDefined();
        found.push({
          name: `${metatype.name}.${method}`,
          declared: Reflect.getMetadata(REQUIRES, handler),
          isPublic: Boolean(Reflect.getMetadata(IS_PUBLIC, handler) ?? Reflect.getMetadata(IS_PUBLIC, metatype)),
        });
      }
    }
  }
  return found;
}

test('every route is public or declares the action it needs', () => {
  const all = routes();
  expect(all.length).toBeGreaterThan(30);
  const undeclared = all.filter((r) => !r.isPublic && r.declared === undefined).map((r) => r.name);
  expect(undeclared).toEqual([]);
  // A public route needs no action, and claiming one would mislead.
  expect(all.filter((r) => r.isPublic && r.declared !== undefined).map((r) => r.name)).toEqual([]);
});

test('declared actions are real ones, and every action in the policy is needed by some route', () => {
  const declared = routes().filter((r) => !r.isPublic).map((r) => r.declared);
  for (const action of declared) expect([...ACTIONS, ANY_PRINCIPAL]).toContain(action);
  expect([...ACTIONS].filter((a) => !declared.includes(a))).toEqual([]);
});

test('a handler that answers without asking the policy fails, and what it wrote is rolled back', async () => {
  const orgId = await createOrg(t.owner);
  const dept = await createDepartment(t.owner, orgId);
  const viewer = await createUser(t.owner, orgId, 'viewer', dept);
  const doc = await createDocument(t.owner, orgId, await createProject(t.owner, orgId, dept), dept, viewer.principal.id);

  // The bug this guards against: someone rewrites a service method and leaves out the check.
  const forgetful = jest.spyOn(t.app.get(DocumentsService), 'remove').mockImplementation(async function remove(this: DocumentsService, id: string) {
    const { db } = (this as unknown as { tenant: { db: import('kysely').Transaction<import('../src/database/schema').Database> } }).tenant;
    await db.deleteFrom('documents').where('id', '=', id).execute();
  });
  try {
    // A viewer may not delete documents. The forgetful method would have let them.
    await t.http().delete(`/documents/${doc}`).set(viewer.headers).expect(500);
  } finally {
    forgetful.mockRestore();
  }
  expect(await t.owner.selectFrom('documents').select('id').where('id', '=', doc).executeTakeFirst()).toBeDefined();
  // With the real method back, the same request is refused properly.
  await t.http().delete(`/documents/${doc}`).set(viewer.headers).expect(403);
});
