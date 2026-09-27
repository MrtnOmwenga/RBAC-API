import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../database/schema';
import type { Principal } from '../policy/policy';
import { type AuditContent, type ChainCheck, eventHash, genesisHash, type StoredEvent, verifyChain } from './chain';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  detail?: Record<string, unknown>;
}

type Actor = Pick<AuditContent, 'actorType' | 'actorId'>;

export const actorOf = (principal: Principal | null): Actor => (principal
  ? { actorType: principal.kind, actorId: principal.id }
  : { actorType: 'anonymous', actorId: null });

@Injectable()
export class AuditService {
  /**
   * Appends an event inside the caller's transaction, so it commits or rolls back with the change
   * it describes. Appends are serialized per organization with an advisory lock, keeping the
   * chain linear under concurrent requests.
   */
  async record(trx: Transaction<Database>, orgId: string, actor: Actor, entry: AuditEntry): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${orgId}, 0))`.execute(trx);
    const last = await trx.selectFrom('audit_events').select(['seq', 'hash'])
      .where('org_id', '=', orgId).orderBy('seq', 'desc').limit(1).executeTakeFirst();
    const content: AuditContent = {
      seq: (last?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      ...actor,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      detail: entry.detail ?? {},
    };
    const prevHash = last?.hash ?? genesisHash(orgId);
    await trx.insertInto('audit_events').values({
      org_id: orgId,
      seq: content.seq,
      at: content.at,
      actor_type: content.actorType,
      actor_id: content.actorId,
      action: content.action,
      resource_type: content.resourceType,
      resource_id: content.resourceId,
      detail: JSON.stringify(content.detail),
      prev_hash: prevHash,
      hash: eventHash(prevHash, content),
    }).execute();
  }

  async list(trx: Transaction<Database>, orgId: string, limit: number): Promise<StoredEvent[]> {
    const rows = await trx.selectFrom('audit_events').selectAll().where('org_id', '=', orgId)
      .orderBy('seq', 'desc').limit(limit).execute();
    return rows.map(toStored);
  }

  async verify(trx: Transaction<Database>, orgId: string): Promise<ChainCheck> {
    const rows = await trx.selectFrom('audit_events').selectAll().where('org_id', '=', orgId).orderBy('seq').execute();
    return verifyChain(orgId, rows.map(toStored));
  }
}

function toStored(row: {
  seq: number; at: Date; actor_type: AuditContent['actorType']; actor_id: string | null; action: string;
  resource_type: string; resource_id: string | null; detail: Record<string, unknown>; prev_hash: string; hash: string;
}): StoredEvent {
  return {
    seq: row.seq,
    at: row.at.toISOString(),
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    detail: row.detail,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}
