import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { migrate } from '../src/database/migrate';
import { randomBytes } from 'node:crypto';
import { appLogin, TEMPLATE_DB, withDatabase } from './support/urls';

declare global {
  var __POSTGRES__: StartedPostgreSqlContainer | undefined;
}

/**
 * One PostgreSQL for the whole run: a real container (Testcontainers), or TEST_DATABASE_URL if
 * set. Migrations run once into a template database; each Jest worker then clones it (see
 * support/database.ts), so workers run in parallel without sharing state.
 */
export default async function globalSetup(): Promise<void> {
  let ownerUrl = process.env.TEST_DATABASE_URL;
  if (!ownerUrl) {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    globalThis.__POSTGRES__ = await new PostgreSqlContainer('postgres:16-alpine').start();
    ownerUrl = globalThis.__POSTGRES__.getConnectionUri();
  }
  // Jest skips globalTeardown when globalSetup throws, so a failure here stops the container itself.
  try {
    const admin = new Client({ connectionString: withDatabase(ownerUrl, 'postgres') });
    await admin.connect();
    const { rows } = await admin.query<{ datname: string }>("select datname from pg_database where datname like 'rbac_test_%' or datname = $1", [TEMPLATE_DB]);
    for (const { datname } of rows) await admin.query(`drop database "${datname}" with (force)`);
    await admin.query(`create database "${TEMPLATE_DB}"`);
    await admin.end();

    process.env.TEST_APP_DB_PASSWORD = randomBytes(16).toString('hex');
    await migrate(withDatabase(ownerUrl, TEMPLATE_DB), withDatabase(ownerUrl, TEMPLATE_DB, appLogin()));
  } catch (err) {
    await globalThis.__POSTGRES__?.stop();
    throw err;
  }
  process.env.TEST_OWNER_URL = ownerUrl;
}
