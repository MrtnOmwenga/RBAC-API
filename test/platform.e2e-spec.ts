import { createTestApp, type TestApp } from './support/app';
import { PASSWORD } from './support/world';

describe('health', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t.close(); });

  test('liveness and readiness need no credentials', async () => {
    await t.http().get('/health/live').expect(200, { status: 'ok' });
    await t.http().get('/health/ready').expect(200, { status: 'ok' });
  });

  test('errors are RFC 9457 problem details and echo a request ID', async () => {
    const res = await t.http().get('/nowhere').set('x-request-id', 'trace-123');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.headers['x-request-id']).toBe('trace-123');
    expect(res.body).toMatchObject({ type: 'about:blank', title: 'Not found', status: 404, instance: '/nowhere' });
  });

  test('validation errors say which field is wrong', async () => {
    const res = await t.http().post('/auth/login').send({ email: 'not-an-email', password: '' }).expect(400);
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['email', 'password']);
  });
});

describe('rate limiting', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp({ AUTH_RATE_LIMIT_PER_MINUTE: '3' }); });
  afterAll(async () => { await t.close(); });

  test('login attempts beyond the budget get 429', async () => {
    const attempt = () => t.http().post('/auth/login').send({ email: 'someone@example.test', password: PASSWORD });
    for (let i = 0; i < 3; i += 1) await attempt().expect(401);
    const limited = await attempt().expect(429);
    expect(limited.headers['retry-after-auth']).toBeDefined();
    await t.http().get('/health/live').expect(200); // other routes are unaffected
  });
});
