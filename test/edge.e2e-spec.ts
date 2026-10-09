import WebSocket from 'ws';
import { createTestApp, type TestApp } from './support/app';

/*
 * With EDGE_SECRET set, the API answers only what came through the reverse proxy in front of it,
 * takes the visitor's address from the proxy, and lets only the proxy call /internal/ paths.
 */

const SECRET = 'edge-secret-that-is-at-least-32-characters';
const viaEdge = { 'x-edge-secret': SECRET };
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ EDGE_SECRET: SECRET, CLIENT_IP_HEADER: 'X-Client-IP', AUTH_RATE_LIMIT_PER_MINUTE: '2', DEMO_MODE: 'true' });
});
afterAll(async () => { await t.close(); });

test('requests that did not come through the proxy are refused; health checks are not', async () => {
  await t.http().get('/me').expect(404);
  await t.http().get('/me').set('x-edge-secret', `${SECRET}x`).expect(404);
  await t.http().get('/me').set(viaEdge).expect(401); // through the proxy: now it is about credentials
  await t.http().get('/health/live').expect(200);
  await t.http().get('/health/ready').expect(200);
});

test('live connections are refused the same way', async () => {
  const open = (headers: Record<string, string>) => new Promise<string>((resolve) => {
    const ws = new WebSocket(`${t.url.replace(/^http/, 'ws')}/collab`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('refused'));
  });
  expect(await open({})).toBe('refused');
  expect(await open(viaEdge)).toBe('open');
});

test("rate limits count the visitor's address as the proxy reports it, not the proxy's own", async () => {
  const login = (address: string) => t.http().post('/auth/login').set({ ...viaEdge, 'x-client-ip': address })
    .send({ email: 'nobody@example.test', password: 'not the password' });
  expect((await login('203.0.113.7')).status).toBe(401);
  expect((await login('203.0.113.7')).status).toBe(401);
  expect((await login('203.0.113.7')).status).toBe(429);
  // Another visitor through the same proxy has their own budget.
  expect((await login('203.0.113.8')).status).toBe(401);
});

test("housekeeping can be run by the proxy's scheduled call, and by nobody else", async () => {
  await t.http().post('/internal/housekeeping').expect(404);
  const res = await t.http().post('/internal/housekeeping').set(viaEdge).expect(200);
  expect(res.body).toEqual({ demos: expect.any(Number) as number, refreshTokens: expect.any(Number) as number });
});

test('without a secret configured, the internal path does not exist', async () => {
  const open = await createTestApp();
  await open.http().post('/internal/housekeeping').expect(404);
  await open.http().get('/health/live').expect(200);
  await open.close();
});
