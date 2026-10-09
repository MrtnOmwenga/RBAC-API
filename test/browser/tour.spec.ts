import { expect, type FrameLocator, type Page, test } from '@playwright/test';

/*
 * The guided tours. "Play it for me" must leave the same real effects it narrates (it drives the
 * real API and editors, so the server's state proves it ran); "Guide me" must move on when the
 * visitor does what it asks, and not before.
 */

const pane = (page: Page, key: string): FrameLocator => page.frameLocator(`iframe[src="/?pane=${key}"]`);

test('"Play it for me" runs by itself, and every effect it narrates really happens', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/?tour=play');
  const first = page.getByRole('button').first();
  await expect(first).toContainText('Play it for me'); // Lighthouse's link puts the requested tour first
  await first.click();
  await expect(page).toHaveURL(/\?room&tour=play$/);

  const card = page.getByRole('region', { name: 'Guided demo' });
  await expect(card).toContainText('step 1 of 7');
  await expect(card).toContainText('Your turn', { timeout: 120_000 });

  // The Analyst was demoted mid-sentence: "The asset" is now redacted on their screen.
  await expect(pane(page, 'analyst').getByLabel('Redacted section')).toHaveCount(2);
  // The Director classified a phrase: it's gone from the Intern's copy.
  await expect(pane(page, 'intern').getByText('Our team attends the')).toBeVisible();
  await expect(pane(page, 'intern').getByText('Lisbon Maritime Trade Fair')).toHaveCount(0);
  // The Liaison was let in, and is cleared for everything.
  await expect(pane(page, 'liaison').getByRole('heading', { name: 'Exfiltration' })).toBeVisible();
  // And it's all on the record.
  await expect(pane(page, 'director').getByText(/chain verified/)).toBeVisible();

  await card.getByRole('button', { name: 'Explore freely' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.pane-frame.tour-dim')).toHaveCount(0);
});

test('"Guide me" waits for the visitor, and moves on when they act', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?tour=guide');
  await page.getByRole('button', { name: /Guide me/ }).click();
  const card = page.getByRole('region', { name: 'Guided tour' });
  await expect(card).toContainText('Lower the Analyst');
  await page.waitForTimeout(2500);
  await expect(card).toContainText('step 1 of 4'); // nothing happens until the visitor acts

  await pane(page, 'director').getByLabel('R. Okoye: clearance').selectOption({ label: 'confidential' });
  await expect(card).toContainText('Classify a few words', { timeout: 15_000 });

  // Classify the words the way a visitor would: select them (here, the whole sentence), press C.
  const director = pane(page, 'director');
  await director.locator('.section-body[data-view="full"] .tiptap p').first().click({ clickCount: 3 });
  await director.getByRole('toolbar', { name: 'Classify selected words' }).first().getByRole('button', { name: 'C', exact: true }).click();
  await expect(card).toContainText('Let the Liaison in', { timeout: 15_000 });

  await director.getByLabel('S. Laurent: share').selectOption('reader');
  await expect(card).toContainText('Ask why', { timeout: 15_000 });
  await pane(page, 'intern').getByRole('button', { name: 'Why can I see this?' }).click();
  await expect(card).toContainText('That\'s everything', { timeout: 15_000 });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 420, height: 860 } });

  test('the Director sits above one chosen agent, and the tour brings each effect into view', async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('/?tour=play');
    await page.getByRole('button').first().click();
    const frame = (key: string) => page.locator(`iframe[src="/?pane=${key}"]`);
    const switcher = page.getByRole('group', { name: 'Agent shown below the Director' });
    const card = page.getByRole('region', { name: 'Guided demo' });

    // Two panes on screen, both within the viewport: the Director and the one the step is about.
    await expect(card).toContainText('step 2 of 7', { timeout: 30_000 });
    await expect(switcher.getByRole('button', { name: 'Intern' })).toHaveAttribute('aria-pressed', 'true');
    await expect(frame('director')).toBeInViewport();
    await expect(frame('intern')).toBeInViewport();
    await expect(frame('liaison')).toBeHidden();
    // The caption sits below the panes, not over the one showing the effect.
    const [paneBox, cardBox] = [await frame('intern').boundingBox(), await card.boundingBox()];
    expect(paneBox!.y + paneBox!.height).toBeLessThanOrEqual(cardBox!.y + 1);

    // When the story moves to the Liaison, so does the screen; the effect lands in a pane that was out of sight.
    await expect(card).toContainText('Share it across divisions', { timeout: 90_000 });
    await expect(switcher.getByRole('button', { name: 'Liaison' })).toHaveAttribute('aria-pressed', 'true');
    await expect(pane(page, 'liaison').getByRole('heading', { name: 'Exfiltration' })).toBeVisible();

    // After the tour, the visitor chooses.
    await expect(card).toContainText('Your turn', { timeout: 60_000 });
    await card.getByRole('button', { name: 'Explore freely' }).click();
    await switcher.getByRole('button', { name: 'Analyst' }).click();
    await expect(frame('analyst')).toBeInViewport();
    await expect(pane(page, 'analyst').getByLabel('Redacted section')).toHaveCount(2); // demoted while it was out of sight
  });
});

test.describe('chapters', () => {
  const start = async (page: Page, chapter: string) => {
    // Straight into the room, with a fresh agency, as the landing page would leave it.
    const session = await (await page.request.post('/demo/sessions')).text();
    await page.addInitScript((value) => sessionStorage.setItem('redacted-session', value), session);
    await page.goto('/?room');
    await expect(page.locator('.pane-frame')).toHaveCount(4);
    await page.getByLabel('More chapters').selectOption({ label: chapter });
    return page.getByRole('region', { name: 'Guided demo' });
  };

  test('"A share that runs out": the Liaison is let in, and put out again by nothing but the clock', async ({ page }) => {
    test.setTimeout(150_000);
    const card = await start(page, 'A share that runs out');
    await expect(card).toContainText('A share with an end');
    await expect(pane(page, 'liaison').getByRole('heading', { name: 'Exfiltration' })).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Now nobody does anything', { timeout: 20_000 });
    // No request is made from here on: the share's twenty seconds pass, and the server's sweep closes the connection.
    await expect(pane(page, 'liaison').getByRole('status').filter({ hasText: 'No access' })).toBeVisible({ timeout: 60_000 });
    await expect(pane(page, 'liaison').getByRole('heading', { name: 'Exfiltration' })).toHaveCount(0);
    await expect(card).toContainText('Ended, and still on the record', { timeout: 20_000 });
    await expect(pane(page, 'director').getByLabel('Surveillance log')).toContainText(/shared as reader until/);
    await expect(pane(page, 'director').getByLabel('S. Laurent: share')).toHaveValue('none');
    await expect(card).toContainText("That's the chapter", { timeout: 20_000 });
    await expect(card.getByRole('button', { name: 'Chapter: The auditor' })).toBeVisible();
  });

  test('"The auditor": reads the whole record, changes nothing, and the attempts are recorded', async ({ page }) => {
    test.setTimeout(120_000);
    const card = await start(page, 'The auditor');
    const evidence = card.getByRole('list', { name: "Requests and the server's answers" });
    await expect(evidence).toContainText('POST /members → 201 A. Hale, auditor');
    await expect(evidence).toContainText('POST /auth/login → 200');

    await expect(card).toContainText('Reads the whole record', { timeout: 20_000 });
    await expect(evidence).toContainText('GET /members → 200 5 members, in every division');
    await expect(evidence).toContainText('the chain verifies');
    await expect(evidence).toContainText('GET /documents/…/briefing → 200 3 of 4 sections redacted');

    await expect(card).toContainText('Changes nothing', { timeout: 20_000 });
    await expect(evidence).toContainText('PATCH /members/… → 403 Not allowed to member:update');
    await expect(evidence).toContainText('POST /documents/…/shares → 403 Not allowed to document:share');
    await expect(evidence).toContainText('DELETE /documents/… → 403 Not allowed to document:delete');

    await expect(card).toContainText('And the attempts are on the record', { timeout: 20_000 });
    await expect(evidence).toContainText('3 refusals recorded for the auditor');
    await expect(card).toContainText("That's the chapter", { timeout: 20_000 });
  });
});
