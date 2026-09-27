import { NotFoundException } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { Database } from '../database/schema';

/*
 * Fetches by ID inside the tenant transaction. Row-level security hides other organizations'
 * rows, so an ID from another tenant is indistinguishable from one that doesn't exist: both 404,
 * and nothing about other tenants leaks.
 */

export async function findDepartment(trx: Transaction<Database>, id: string) {
  const row = await trx.selectFrom('departments').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw new NotFoundException('No such department');
  return row;
}

export async function findMember(trx: Transaction<Database>, id: string) {
  const row = await trx.selectFrom('users').select(['id', 'org_id', 'email', 'name', 'role', 'department_id', 'clearance', 'disabled_at', 'created_at'])
    .where('id', '=', id).executeTakeFirst();
  if (!row) throw new NotFoundException('No such member');
  return row;
}

export async function findProject(trx: Transaction<Database>, id: string) {
  const row = await trx.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw new NotFoundException('No such project');
  return row;
}

export async function findDocument(trx: Transaction<Database>, id: string) {
  const row = await trx.selectFrom('documents').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw new NotFoundException('No such document');
  return row;
}
