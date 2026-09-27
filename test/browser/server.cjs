// Starts PostgreSQL (Testcontainers), migrates, and runs the compiled API in demo mode on :3100,
// serving the built web app. Used by playwright.config.ts.
const { randomBytes } = require('node:crypto');
const path = require('node:path');

(async () => {
  if (process.env.DOCKER_HOST?.includes('podman')) process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
  const { PostgreSqlContainer } = require('@testcontainers/postgresql');
  const pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const stop = () => pg.stop().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  const owner = pg.getConnectionUri();
  const app = new URL(owner);
  app.username = 'rbac_app_login';
  app.password = randomBytes(16).toString('hex');
  const root = path.resolve(__dirname, '..', '..');
  const { migrate } = require(path.join(root, 'dist/database/migrate.js'));
  await migrate(owner, app.toString());

  Object.assign(process.env, {
    NODE_ENV: 'test', PORT: '3100', LOG_LEVEL: 'warn', DATABASE_URL: app.toString(), JWT_SECRET: randomBytes(32).toString('hex'),
    DEMO_MODE: 'true', WEB_DIR: path.join(root, 'web/dist'), RATE_LIMIT_PER_MINUTE: '100000', AUTH_RATE_LIMIT_PER_MINUTE: '10000',
  });
  require(path.join(root, 'dist/main.js'));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
