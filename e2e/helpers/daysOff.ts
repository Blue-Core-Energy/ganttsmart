import { expect, type Page } from '@playwright/test';

export interface DayOffEntry {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  assigneeName: string | null;
}

/**
 * Serves the days off API from memory so these tests never touch the shared dev server's
 * calendar (other tests run against the same server in parallel).
 */
export async function mockDaysOffApi(page: Page, initial: DayOffEntry[] = []): Promise<DayOffEntry[]> {
  const entries = [...initial];
  let counter = 0;
  await page.route('**/api/days-off**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ daysOff: entries }),
      });
      return;
    }
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Omit<DayOffEntry, 'id'>;
      const entry: DayOffEntry = {
        id: `nwd-${++counter}`,
        label: body.label,
        startDate: body.startDate,
        endDate: body.endDate ?? body.startDate,
        assigneeName: body.assigneeName ?? null,
      };
      entries.push(entry);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ dayOff: entry }),
      });
      return;
    }
    const id = decodeURIComponent(new URL(req.url()).pathname.split('/').pop() ?? '');
    const at = entries.findIndex((e) => e.id === id);
    if (at >= 0) entries.splice(at, 1);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  return entries;
}

export async function openDaysOffDialog(page: Page): Promise<void> {
  await page.getByTitle('Account').click();
  await page.getByRole('button', { name: /Days Off/ }).click();
}

export async function addDayOffViaDialog(
  page: Page,
  entry: { label: string; start: string; end?: string; person?: string },
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Days Off' });
  await openDaysOffDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(entry.label);
  await dialog.getByLabel('Start date', { exact: true }).fill(entry.start);
  if (entry.end) await dialog.getByLabel(/^End date/).fill(entry.end);
  if (entry.person) {
    await dialog.getByLabel('Applies to', { exact: true }).selectOption('person');
    await dialog.getByLabel('Person', { exact: true }).fill(entry.person);
  }
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.locator(`[data-day-off-entry="${entry.label}"]`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}
