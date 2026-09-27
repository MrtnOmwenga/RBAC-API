import { sql } from 'kysely';
import { createTestApp, type TestApp } from './support/app';

describe('demo mode on', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp({ DEMO_MODE: 'true' }); });
  afterAll(async () => { await t.close(); });

  const start = async () => (await t.http().post('/demo/sessions').expect(201)).body as {
    briefingId: string; characters: { key: string; id: string; accessToken: string }[];
  };
  const as = (session: Awaited<ReturnType<typeof start>>, key: string) => ({ authorization: `Bearer ${session.characters.find((c) => c.key === key)!.accessToken}` });

  test('a session is a private agency where each character sees what their access allows', async () => {
    const s = await start();
    const view = async (key: string) => (await t.http().get(`/documents/${s.briefingId}/briefing`).set(as(s, key))).body;
    expect((await view('director')).sections.map((x: { access: string }) => x.access)).toEqual(['edit', 'edit', 'edit', 'edit']);
    expect((await view('analyst')).sections.map((x: { access: string }) => x.access)).toEqual(['edit', 'edit', 'edit', 'none']);
    expect((await view('intern')).sections.map((x: { access: string }) => x.access)).toEqual(['read', 'none', 'none', 'none']);
    await t.http().get(`/documents/${s.briefingId}/briefing`).set(as(s, 'liaison')).expect(403);
    const other = await start();
    await t.http().get(`/documents/${s.briefingId}/briefing`).set(as(other, 'director')).expect(404);
  });

  test('the director drives the demo through the ordinary API', async () => {
    const s = await start();
    const liaison = s.characters.find((c) => c.key === 'liaison')!;
    await t.http().post(`/documents/${s.briefingId}/shares`).set(as(s, 'director'))
      .send({ subjectType: 'user', subjectId: liaison.id, relation: 'reader' }).expect(201);
    await t.http().get(`/documents/${s.briefingId}/briefing`).set(as(s, 'liaison')).expect(200);
  });

  test('expired demo agencies are deleted by the cleanup function', async () => {
    const s = await start();
    const org = await t.owner.selectFrom('users').select('org_id').where('id', '=', s.characters[0]!.id).executeTakeFirstOrThrow();
    await t.owner.updateTable('organizations').set({ created_at: sql`now() - interval '3 hours'` } as never).where('id', '=', org.org_id).execute();
    const { rows } = await sql<{ demo_cleanup: number }>`select demo_cleanup('2 hours'::interval)`.execute(t.appDb);
    expect(rows[0]!.demo_cleanup).toBeGreaterThanOrEqual(1);
    expect(await t.owner.selectFrom('organizations').select('id').where('id', '=', org.org_id).executeTakeFirst()).toBeUndefined();
  });
});

test('with demo mode off, the endpoint does not exist', async () => {
  const t = await createTestApp();
  await t.http().post('/demo/sessions').expect(404);
  await t.close();
});
