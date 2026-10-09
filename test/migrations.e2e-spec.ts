import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { migrate } from '../src/database/migrate';
import { migrations } from '../src/database/migrations';
import { withDatabase } from './support/urls';

/*
 * Every migration can be undone. In a database of its own, they are all applied, all undone, and
 * applied again: undoing must leave nothing behind, and the second schema must equal the first.
 */

const name = `rbac_migrations_${randomUUID().slice(0, 8)}`;
const base = () => process.env.TEST_OWNER_URL!;
let db: Client;

beforeAll(async () => {
  const admin = new Client({ connectionString: withDatabase(base(), 'postgres') });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  await admin.end();
  db = new Client({ connectionString: withDatabase(base(), name) });
  await db.connect();
});
afterAll(async () => {
  await db.end();
  const admin = new Client({ connectionString: withDatabase(base(), 'postgres') });
  await admin.connect();
  await admin.query(`drop database "${name}" with (force)`);
  await admin.end();
});

/** Everything the migrations create, as text: columns, constraints, indexes, policies, functions, grants. */
async function schema(): Promise<string[]> {
  const queries = [
    `select 'column ' || table_name || '.' || column_name || ' ' || data_type || ' null=' || is_nullable || ' default=' || coalesce(column_default, '') as line
       from information_schema.columns where table_schema = 'public' and table_name not like 'kysely_%'`,
    `select 'constraint ' || conrelid::regclass || ' ' || pg_get_constraintdef(oid) as line from pg_constraint where connamespace = 'public'::regnamespace
       and conrelid::regclass::text not like 'kysely_%'`,
    `select 'index ' || indexdef as line from pg_indexes where schemaname = 'public' and tablename not like 'kysely_%'`,
    `select 'policy ' || tablename || ' ' || policyname || ' ' || coalesce(qual, '') || ' / ' || coalesce(with_check, '') as line from pg_policies where schemaname = 'public'`,
    `select 'rls ' || relname || ' ' || relrowsecurity || ' ' || relforcerowsecurity as line from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' and relname not like 'kysely_%'`,
    `select 'function ' || p.oid::regprocedure || ' definer=' || prosecdef || ' ' || prosrc as line from pg_proc p where pronamespace = 'public'::regnamespace`,
    `select 'grant ' || grantee || ' ' || privilege_type || ' on ' || table_name as line from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'rbac_app'`,
    `select 'grant ' || grantee || ' execute on ' || routine_name as line from information_schema.role_routine_grants
       where routine_schema = 'public' and grantee in ('rbac_app', 'PUBLIC')`,
  ];
  const lines: string[] = [];
  for (const q of queries) lines.push(...(await db.query<{ line: string }>(q)).rows.map((r) => r.line));
  return lines.sort();
}

test('every migration has a way back', () => {
  for (const [id, migration] of Object.entries(migrations)) expect([id, typeof migration.down]).toEqual([id, 'function']);
});

test('all migrations run down to nothing and up again to the same schema', async () => {
  const url = withDatabase(base(), name);
  await migrate(url);
  const first = await schema();
  expect(first.length).toBeGreaterThan(80);

  await migrate(url, undefined, undefined, 'nothing');
  expect(await schema()).toEqual([]);

  await migrate(url);
  expect(await schema()).toEqual(first);
});

test('the schema can be rolled back one release and forward again', async () => {
  const url = withDatabase(base(), name);
  const ids = Object.keys(migrations);
  const latest = await schema();
  await migrate(url, undefined, undefined, ids.at(-2));
  expect(await schema()).not.toEqual(latest);
  await migrate(url);
  expect(await schema()).toEqual(latest);
});
