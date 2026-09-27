import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { ACCESS_CHANNEL } from '../briefings/access';
import type { Database } from '../database/schema';
import { RealtimeService } from './realtime.service';

/**
 * Call inside any transaction that changes who may see or edit what. It fails closed: this
 * server's live connections in the organization turn read-only *before* the change commits, so no
 * edit can slip in between the commit and the re-check. The notification (delivered on commit)
 * makes every server re-check and restore whoever is still allowed to write.
 */
@Injectable()
export class AccessChanges {
  constructor(private readonly realtime: RealtimeService) {}

  async announce(trx: Transaction<Database>, orgId: string): Promise<void> {
    this.realtime.lock(orgId);
    await sql`select pg_notify(${ACCESS_CHANNEL}, ${orgId})`.execute(trx);
  }
}
