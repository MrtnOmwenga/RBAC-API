import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { type Kysely, sql } from 'kysely';
import { Public } from '../common/http';
import type { Database } from '../database/schema';
import { DB } from '../database/tenant';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  /** The process is up. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** The process can serve traffic: the database answers. */
  @Get('ready')
  async ready() {
    try {
      await sql`select 1`.execute(this.db);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}
