import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { CONFIG, type Config } from '../config/config';
import type { Database } from './schema';
import { DB, TenantContext } from './tenant';

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [CONFIG],
      useFactory: (config: Config) => new Kysely<Database>({
        dialect: new PostgresDialect({ pool: new Pool({ connectionString: config.DATABASE_URL, max: 10 }) }),
      }),
    },
    TenantContext,
  ],
  exports: [DB, TenantContext],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
