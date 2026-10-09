import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { ACCESS_CHANNEL } from '../briefings/access';
import type { Database } from '../database/schema';
import { RealtimeService, type Scope } from './realtime.service';

/**
 * Call inside any transaction that changes who may see or edit what. It fails closed: this
 * server's live connections that the change could affect turn read-only *before* it commits, so no
 * edit can slip in between the commit and the re-check. The notification (delivered on commit)
 * makes every server re-check and restore whoever is still allowed to write.
 *
 * `scope` says how far the change reaches: one member's access, one document's, or (left out)
 * anything in the organization. Editors the change can't touch are left alone.
 */
@Injectable()
export class AccessChanges {
  constructor(private readonly realtime: RealtimeService) {}

  async announce(trx: Transaction<Database>, orgId: string, scope?: Scope): Promise<void> {
    this.realtime.lock(orgId, scope);
    const payload = scope ? `${orgId} ${'member' in scope ? `member ${scope.member}` : `document ${scope.document}`}` : orgId;
    await sql`select pg_notify(${ACCESS_CHANNEL}, ${payload})`.execute(trx);
  }
}
