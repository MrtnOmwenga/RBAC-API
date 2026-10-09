import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { CONFIG, type Config } from '../config/config';
import type { Database } from '../database/schema';
import { DB } from '../database/tenant';

const EVERY_MS = 5 * 60_000;
const NUDGE_AT_MOST_EVERY_MS = 60_000;

/*
 * Deletes what has outlived its use: expired demo agencies and dead refresh tokens.
 *
 * A timer alone isn't enough. Where the platform only runs the process while it is handling a
 * request, a timer doesn't fire on an idle instance, so the work is also nudged by the requests
 * that create it (starting a demo, signing in).
 */
@Injectable()
export class HousekeepingService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Housekeeping');
  private readonly checkpoints = new Logger('AuditCheckpoint');
  private timer?: NodeJS.Timeout;
  private last = 0;

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(CONFIG) private readonly config: Config,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => { void this.run(); }, EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Runs the clean-up unless it ran in the last minute. */
  async nudge(): Promise<void> {
    if (Date.now() - this.last >= NUDGE_AT_MOST_EVERY_MS) await this.run();
  }

  async run(): Promise<{ demos: number; refreshTokens: number; checkpoints: number }> {
    const since = this.last;
    this.last = Date.now();
    const done = { demos: 0, refreshTokens: 0, checkpoints: 0 };
    try {
      if (this.config.DEMO_MODE) {
        const { rows } = await sql<{ n: number }>`select demo_cleanup(${`${this.config.DEMO_TTL_MINUTES} minutes`}::interval) as n`.execute(this.db);
        done.demos = rows[0]?.n ?? 0;
      }
      const { rows } = await sql<{ n: number }>`select auth_prune_refresh_tokens() as n`.execute(this.db);
      done.refreshTokens = rows[0]?.n ?? 0;
      // A signed checkpoint for every log that grew since the last run, written where the database
      // owner can't reach: the service's own log stream. (audit/checkpoint.ts says what it's for.)
      const window = `${Math.ceil(Math.min(this.last - since, 86_400_000) / 1000) + 60} seconds`;
      const heads = await sql<{ org_id: string; seq: number; hash: string }>`select * from audit_heads(${window}::interval)`.execute(this.db);
      for (const head of heads.rows) {
        this.checkpoints.log({ msg: 'audit checkpoint', checkpoint: this.audit.sign(head.org_id, head) });
      }
      done.checkpoints = heads.rows.length;
    } catch (err) {
      this.logger.warn(`housekeeping failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return done;
  }
}
