import { Kysely, Migrator, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { migrations } from './migrations';

/**
 * Applies migrations as the owner (`ownerUrl`), then makes sure the API's login role (the user in
 * `appUrl`) exists, can log in with its password and is a member of `rbac_app`. The password comes
 * from `appUrl` or, to keep it out of URLs, from `appPassword`.
 */
export async function migrate(ownerUrl: string, appUrl?: string, appPassword?: string): Promise<void> {
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: ownerUrl, max: 1 }) }) });
  try {
    const { error, results } = await new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } }).migrateToLatest();
    for (const r of results ?? []) {
      if (r.status === 'Error') console.error(`migration ${r.migrationName} failed`);
    }
    if (error) throw error instanceof Error ? error : new Error(`migration failed: ${JSON.stringify(error)}`);

    if (appUrl) {
      const { username, password: inUrl } = new URL(appUrl);
      const role = decodeURIComponent(username);
      const password = inUrl ? decodeURIComponent(inUrl) : appPassword;
      if (!password) throw new Error('The API role needs a password: put it in DATABASE_URL or APP_DB_PASSWORD');
      await db.transaction().execute(async (trx) => {
        await sql`
          select set_config('rbac.login', ${role}, true), set_config('rbac.password', ${password}, true)
        `.execute(trx);
        await sql`
          do $$ begin
            if not exists (select from pg_roles where rolname = current_setting('rbac.login')) then
              execute format('create role %I login password %L', current_setting('rbac.login'), current_setting('rbac.password'));
            else
              execute format('alter role %I login password %L', current_setting('rbac.login'), current_setting('rbac.password'));
            end if;
            execute format('grant rbac_app to %I', current_setting('rbac.login'));
            execute format('grant connect on database %I to %I', current_database(), current_setting('rbac.login'));
          end $$;
        `.execute(trx);
      });
    }
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('Set MIGRATION_DATABASE_URL (the database owner) to run migrations');
    process.exit(1);
  }
  migrate(ownerUrl, process.env.DATABASE_URL, process.env.APP_DB_PASSWORD).then(
    () => console.log('migrations applied'),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
