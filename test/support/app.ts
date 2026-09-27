import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { AppModule, configureApp } from '../../src/app.module';
import { type Config, loadConfig } from '../../src/config/config';
import type { Database } from '../../src/database/schema';
import { workerDatabase } from './database';

// Generated per test process: nothing secret-looking is committed, and each run uses its own.
export const TEST_JWT_SECRET = randomBytes(32).toString('hex');

export interface TestApp {
  app: INestApplication;
  http: () => TestAgent;
  /** The database owner: bypasses row-level security. Used to seed and to play an attacker. */
  owner: Kysely<Database>;
  /** The API's own least-privilege role, for testing what the database itself allows it. */
  appDb: Kysely<Database>;
  config: Config;
  /** Base URL of the listening server (the realtime tests connect to it over WebSockets). */
  url: string;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Partial<Record<keyof Config, string>> = {}): Promise<TestApp> {
  const { ownerUrl, appUrl } = await workerDatabase();
  const config = loadConfig({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: appUrl, JWT_SECRET: TEST_JWT_SECRET,
    RATE_LIMIT_PER_MINUTE: '1000000', AUTH_RATE_LIMIT_PER_MINUTE: '1000000', ...overrides,
  });
  const app = await NestFactory.create(AppModule.forRoot(config), { logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const owner = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: ownerUrl, max: 3 }) }) });
  const appDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: appUrl, max: 2 }) }) });
  return {
    app,
    http: () => request(app.getHttpServer()),
    owner,
    appDb,
    config,
    url: await app.getUrl(),
    close: async () => {
      await app.close();
      await owner.destroy();
      await appDb.destroy();
    },
  };
}
