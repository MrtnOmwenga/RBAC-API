import { Client } from 'pg';
import { appLogin, TEMPLATE_DB, withDatabase } from './urls';

let prepared: Promise<{ ownerUrl: string; appUrl: string }> | undefined;

/** This worker's own database, cloned from the migrated template on first use. */
export function workerDatabase(): Promise<{ ownerUrl: string; appUrl: string }> {
  prepared ??= (async () => {
    const base = process.env.TEST_OWNER_URL;
    if (!base) throw new Error('TEST_OWNER_URL is not set: run the e2e tests through jest (global-setup.ts)');
    const name = `rbac_test_${process.env.JEST_WORKER_ID ?? '1'}`;
    const admin = new Client({ connectionString: withDatabase(base, 'postgres') });
    await admin.connect();
    try {
      const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
      if (exists.rowCount === 0) {
        // Two workers cloning the same template at the same instant can collide; retry briefly.
        for (let attempt = 1; ; attempt += 1) {
          try {
            await admin.query(`create database "${name}" template "${TEMPLATE_DB}"`);
            break;
          } catch (err) {
            if ((err as { code?: string }).code !== '55006' || attempt === 20) throw err;
            await new Promise((r) => { setTimeout(r, 50 * attempt); });
          }
        }
      }
    } finally {
      await admin.end();
    }
    return { ownerUrl: withDatabase(base, name), appUrl: withDatabase(base, name, appLogin()) };
  })();
  return prepared;
}
