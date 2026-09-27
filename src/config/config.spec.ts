import { loadConfig } from './config';

const valid = { DATABASE_URL: 'postgres://u:p@localhost/db', JWT_SECRET: 'x'.repeat(32) };

test('applies defaults', () => {
  expect(loadConfig(valid)).toMatchObject({ PORT: 3000, ACCESS_TOKEN_TTL_SECONDS: 900, LOGIN_MAX_FAILURES: 5 });
});

test('refuses to start with a weak secret or missing database, listing every problem', () => {
  expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET: JWT_SECRET must be at least 32/);
});
