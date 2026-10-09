import { loadConfig } from './config';

const valid = { DATABASE_URL: 'postgres://u:p@localhost/db', JWT_SECRET: 'x'.repeat(32) };

test('applies defaults', () => {
  expect(loadConfig(valid)).toMatchObject({ PORT: 3000, ACCESS_TOKEN_TTL_SECONDS: 900, LOGIN_MAX_FAILURES: 5 });
});

test('refuses to start with a weak secret or missing database, listing every problem', () => {
  expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET: JWT_SECRET must be at least 32/);
});

test("the proxy's word on the visitor's address is only taken together with the proxy's secret", () => {
  expect(() => loadConfig({ ...valid, CLIENT_IP_HEADER: 'X-Client-IP' })).toThrow(/CLIENT_IP_HEADER: needs EDGE_SECRET/);
  expect(() => loadConfig({ ...valid, EDGE_SECRET: 'short' })).toThrow(/EDGE_SECRET must be at least 32/);
  expect(loadConfig({ ...valid, EDGE_SECRET: 'e'.repeat(32), CLIENT_IP_HEADER: 'X-Client-IP' })).toMatchObject({ CLIENT_IP_HEADER: 'X-Client-IP' });
});
