import { type APIRequestContext, expect, type FrameLocator, type Page, test } from '@playwright/test';

/*
 * The demo UI, driven like a visitor would. The first test is the important one: it records
 * everything the intern's browser receives (HTTP responses and every WebSocket frame) and checks
 * that none of it contains the text the intern isn't cleared for.
 */

// Words above the intern's clearance: whole classified sections, and words marked inside the section they can read.
const HIDDEN = ['MERIDIAN', 'deputy minister', 'Cabo da Roca', 'Atlas Freight'];

interface Session { briefingId: string; expiresAt: string; characters: { key: string }[] }

async function newSession(request: APIRequestContext): Promise<Session> {
  const res = await request.post('/demo/sessions');
  expect(res.status()).toBe(201);
  return res.json() as Promise<Session>;
}

/** Opens `url` with the demo session already in sessionStorage, as the landing page would leave it. */
async function openWith(page: Page, session: Session, url: string) {
  await page.addInitScript((value) => sessionStorage.setItem('redacted-session', value), JSON.stringify(session));
  await page.goto(url);
}

const pane = (page: Page, key: string): FrameLocator => page.frameLocator(`iframe[src="/?pane=${key}"]`);

test('the intern\'s browser never receives the text of sections above their clearance', async ({ page, request }) => {
  const session = await newSession(request);
  const received: string[] = [];
  page.on('response', async (res) => { received.push(await res.text().catch(() => '')); });
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    received.push(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'));
  }));

  await openWith(page, session, '/?pane=intern');
  await expect(page.getByText('Our team attends the Lisbon Maritime Trade Fair')).toBeVisible();
  await expect(page.getByLabel('Redacted section')).toHaveCount(3);
  await expect(page.getByLabel('redacted words')).toHaveCount(1); // the front company's name, mid-sentence
  await page.waitForTimeout(1000); // let every socket settle

  const everything = received.join('\n');
  expect(everything).toContain('Lisbon Maritime Trade Fair'); // the capture works: the visible text is in it
  for (const phrase of HIDDEN) expect(everything).not.toContain(phrase);
});

test('the room: four agents, four views of one briefing', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Enter the briefing room' }).click();
  await expect(page).toHaveURL(/\?room$/);
  await expect(pane(page, 'director').getByLabel('Redacted section')).toHaveCount(0);
  await expect(pane(page, 'analyst').getByLabel('Redacted section')).toHaveCount(1);
  await expect(pane(page, 'intern').getByLabel('Redacted section')).toHaveCount(3);
  await expect(pane(page, 'liaison').getByText('No access')).toHaveCount(2); // the badge and the stamp
});

test('made a viewer mid-sentence, the analyst\'s editor locks and later keystrokes go nowhere', async ({ page, request }) => {
  await openWith(page, await newSession(request), '/?room');
  const analyst = pane(page, 'analyst');
  const director = pane(page, 'director');
  const cover = analyst.locator('.section-body').first();
  await expect(cover).toHaveAttribute('data-access', 'edit');
  await cover.locator('.tiptap').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Before.');
  await expect(director.getByText('Before.', { exact: false })).toBeVisible();

  await director.getByLabel('R. Okoye: role').selectOption('viewer');
  await expect(cover).toHaveAttribute('data-access', 'read');
  await expect(analyst.locator('.tiptap').first()).toHaveAttribute('contenteditable', 'false');
  await cover.locator('.tiptap').click();
  await page.keyboard.type(' After.');
  await page.waitForTimeout(1000);
  await expect(director.getByText('After.')).toHaveCount(0);
});

test('lowering clearance redacts a section live; a share lets the liaison in', async ({ page, request }) => {
  await openWith(page, await newSession(request), '/?room');
  const analyst = pane(page, 'analyst');
  const director = pane(page, 'director');
  const liaison = pane(page, 'liaison');
  await expect(analyst.getByText('shipping manifests')).toBeVisible();

  await director.getByLabel('R. Okoye: clearance').selectOption('1');
  await expect(analyst.getByLabel('Redacted section')).toHaveCount(2);
  await expect(analyst.getByText('shipping manifests')).toHaveCount(0);

  await director.getByLabel('S. Laurent: share').selectOption('reader');
  await expect(liaison.getByText('Operation NIGHTJAR: mission briefing', { exact: false })).toBeVisible();
  await expect(liaison.getByText('Read only')).toBeVisible();
  await liaison.getByRole('button', { name: 'Why can I see this?' }).click();
  await expect(liaison.getByLabel('Why can I see this?')).toContainText('shared with them directly as reader');
});

test('every change lands in the surveillance log, and the chain verifies', async ({ page, request }) => {
  await openWith(page, await newSession(request), '/?room');
  const director = pane(page, 'director');
  await director.getByLabel('J. Park: clearance').selectOption('2');
  await director.getByLabel('S. Laurent: share').selectOption('editor');
  const log = director.getByLabel('Surveillance log');
  await expect(log).toContainText('clearance unclassified → secret');
  await expect(log).toContainText('shared as editor');
  await expect(log).toContainText('chain verified · 3');
});

test('words the director classifies black out for the intern mid-sentence, live', async ({ page, request }) => {
  await openWith(page, await newSession(request), '/?room');
  const director = pane(page, 'director');
  const intern = pane(page, 'intern');
  await expect(intern.getByText('Lisbon Maritime Trade Fair')).toBeVisible();
  await expect(intern.getByLabel('redacted words')).toHaveCount(1);

  // Select the cover story's first sentence in the Director's copy and mark it SECRET.
  const sentence = director.locator('.section-body[data-view="full"] .tiptap p').first();
  await sentence.click({ clickCount: 3 });
  await director.getByRole('toolbar', { name: 'Classify selected words' }).first().getByRole('button', { name: 'S', exact: true }).click();

  await expect(intern.getByText('Lisbon Maritime Trade Fair')).toHaveCount(0);
  await expect(intern.getByLabel('redacted words')).toHaveCount(2);
  await expect(director.locator('.classified[data-level="2"]').getByText('Lisbon Maritime Trade Fair', { exact: false })).toBeVisible();
  // The Analyst (secret) still reads it, now portion-marked.
  await expect(pane(page, 'analyst').locator('.classified[data-level="2"]').first()).toContainText('Lisbon Maritime');
});
