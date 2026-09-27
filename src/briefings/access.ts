import { NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../database/schema';
import { type Access, documentAccess, type Grant, type Principal } from '../policy/policy';

/*
 * One place that answers "what may this principal do with this document?", used by the REST API
 * and by the realtime server alike, so a browser tab and a WebSocket can never disagree.
 */

export const ACCESS_CHANNEL = 'rbac_access_changed';

export async function grantsOf(trx: Transaction<Database>, documentId: string): Promise<(Grant & { id: string; grantedBy: string; createdAt: Date })[]> {
  const rows = await trx.selectFrom('document_grants').selectAll().where('document_id', '=', documentId).execute();
  return rows.map((g) => ({
    id: g.id, subjectType: g.subject_type, subjectId: g.subject_id, relation: g.relation, expiresAt: g.expires_at, grantedBy: g.granted_by, createdAt: g.created_at,
  }));
}

export async function loadDocumentAccess(trx: Transaction<Database>, principal: Principal, documentId: string) {
  const document = await trx.selectFrom('documents').selectAll().where('id', '=', documentId).executeTakeFirst();
  if (!document) throw new NotFoundException('No such document');
  const grants = await grantsOf(trx, documentId);
  const resource = { orgId: document.org_id, departmentId: document.department_id, ownerId: document.author_id };
  const access: Access = documentAccess(principal, resource, grants);
  return { document, grants, resource, access };
}

/**
 * Tells every realtime server (this one included, across instances) that permissions in an
 * organization changed. Sent inside the caller's transaction, so it's delivered only on commit.
 */
export async function announceAccessChange(trx: Transaction<Database>, orgId: string): Promise<void> {
  await sql`select pg_notify(${ACCESS_CHANNEL}, ${orgId})`.execute(trx);
}

/** Redaction bars are sized from text length, rounded up so they don't give away exact lengths. */
export const redactedLength = (length: number): number => Math.max(40, Math.ceil(length / 40) * 40);
