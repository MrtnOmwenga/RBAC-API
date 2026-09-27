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
