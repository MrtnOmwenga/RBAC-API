import { Inject, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { Page } from '../common/pagination';
import { CONFIG, type Config } from '../config/config';
import type { Database } from '../database/schema';
import type { Principal } from '../policy/policy';
import { checkAgainst, type Checkpoint, type CheckpointCheck, checkpointKey, signCheckpoint } from './checkpoint';
import { type AuditContent, type ChainCheck, eventHash, genesisHash, type StoredEvent, verifyChain } from './chain';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  detail?: Record<string, unknown>;
}

export interface AuditFilter {
  actorId?: string | undefined;
  resourceId?: string | undefined;
  action?: string | undefined;
  /** Actions to leave out (exact names): a view of changes without the reads, say. */
  exclude?: string[] | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

type Actor = Pick<AuditContent, 'actorType' | 'actorId'>;

export const actorOf = (principal: Principal | null): Actor => (principal
  ? { actorType: principal.kind, actorId: principal.id }
  : { actorType: 'anonymous', actorId: null });

@Injectable()
export class AuditService {
  private readonly key: ReturnType<typeof checkpointKey>;

  constructor(@Inject(CONFIG) config: Config) {
    this.key = checkpointKey(config.JWT_SECRET);
  }

  /** The key checkpoints are signed with, for anyone checking one without asking this service. */
  get checkpointPublicKey(): string {
    return this.key.publicKey;
  }

  /** A signed statement of where the organization's log ends right now. */
  async checkpoint(trx: Transaction<Database>, orgId: string): Promise<Checkpoint> {
    const last = await trx.selectFrom('audit_events').select(['seq', 'hash']).where('org_id', '=', orgId).orderBy('seq', 'desc').limit(1).executeTakeFirst();
    return signCheckpoint(this.key.privateKey, orgId, last, new Date());
  }

  /** Signs a checkpoint for a log's end read elsewhere (housekeeping reads every organization's at once). */
  sign(orgId: string, last: { seq: number; hash: string }): Checkpoint {
    return signCheckpoint(this.key.privateKey, orgId, last, new Date());
  }

  /** The whole chain, and whether it still agrees with a checkpoint taken earlier. */
  async verifyAgainst(trx: Transaction<Database>, orgId: string, checkpoint: Checkpoint): Promise<ChainCheck & { checkpoint: CheckpointCheck }> {
    const chain = await this.verify(trx, orgId);
    const event = checkpoint.seq > 0
      ? await trx.selectFrom('audit_events').select('hash').where('org_id', '=', orgId).where('seq', '=', checkpoint.seq).executeTakeFirst()
      : undefined;
    return { ...chain, checkpoint: checkAgainst(this.key.privateKey, orgId, checkpoint, event) };
  }

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

  /** Newest first, narrowed by who, what, which resource and when; `before` continues from a page. */
  async list(trx: Transaction<Database>, orgId: string, filter: AuditFilter & { limit: number; before?: number | undefined }): Promise<Page<StoredEvent>> {
    let query = this.matching(trx, orgId, filter).orderBy('seq', 'desc').limit(filter.limit + 1);
    if (filter.before !== undefined) query = query.where('seq', '<', filter.before);
    const rows = await query.execute();
    const items = rows.slice(0, filter.limit).map(toStored);
    return new Page(items, rows.length > filter.limit ? String(items.at(-1)!.seq) : null, 'before');
  }

  /**
   * Oldest first, for handing the log to someone else: each event with its hashes, so the chain
   * can be re-verified from the export alone. `after` continues from a page.
   */
  async export(trx: Transaction<Database>, orgId: string, filter: AuditFilter & { limit: number; after?: number | undefined }): Promise<Page<StoredEvent>> {
    let query = this.matching(trx, orgId, filter).orderBy('seq', 'asc').limit(filter.limit + 1);
    if (filter.after !== undefined) query = query.where('seq', '>', filter.after);
    const rows = await query.execute();
    const items = rows.slice(0, filter.limit).map(toStored);
    return new Page(items, rows.length > filter.limit ? String(items.at(-1)!.seq) : null, 'after');
  }

  private matching(trx: Transaction<Database>, orgId: string, filter: AuditFilter) {
    let query = trx.selectFrom('audit_events').selectAll().where('org_id', '=', orgId);
    if (filter.actorId) query = query.where('actor_id', '=', filter.actorId);
    if (filter.resourceId) query = query.where('resource_id', '=', filter.resourceId);
    // "auth." matches every action in that family; anything else matches exactly.
    if (filter.action) query = filter.action.endsWith('.') ? query.where('action', 'like', `${filter.action.replace(/[%_\\]/g, '\\$&')}%`) : query.where('action', '=', filter.action);
    if (filter.exclude?.length) query = query.where('action', 'not in', filter.exclude);
    if (filter.from) query = query.where('at', '>=', filter.from);
    if (filter.to) query = query.where('at', '<', filter.to);
    return query;
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
