import { expect, test } from '@playwright/test';
import {
  addDayOffViaDialog,
  blockFonts,
  isoOffsetDays,
  mockDaysOffApi,
  mockLinearIssues,
  mondayOffset,
  openDaysOffDialog,
  trackErrors,
  type DayOffEntry,
} from './helpers/index.js';

test.describe('GanttSmart GCP app', () => {
  test.beforeEach(async ({ page }) => {
    await blockFonts(page);
  });

  test("adds a company-wide day off and one person's day off, shades the timeline, and snaps affected tasks forward", async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const mon = mondayOffset();
    const wed = mon + 2;
    const thu = mon + 3;
    const fri = mon + 4;

    const { dueUpdates, startUpdates } = await mockLinearIssues(page, [
      // Due on the holiday (Wed): the due date should move to Thu
      {
        id: 'uuid-201',
        identifier: 'ENG-201',
        title: 'Due on holiday',
        assignee: 'Andrew Phillips',
        startOffset: mon,
        dueOffset: wed,
      },
      // Starts on the holiday: the start should move to Thu
      {
        id: 'uuid-202',
        identifier: 'ENG-202',
        title: 'Starts on holiday',
        assignee: 'Nate Jones',
        startOffset: wed,
        dueOffset: fri,
      },
      // Entirely before the holiday: untouched
      {
        id: 'uuid-203',
        identifier: 'ENG-203',
        title: 'Before holiday',
        assignee: 'Nate Jones',
        startOffset: mon,
        dueOffset: mon + 1,
      },
    ]);
    const entries = await mockDaysOffApi(page);

    await page.goto('/app');
    const barWidth = async (id: string) => (await page.locator(`[data-task-bar="${id}"]`).boundingBox())!.width;
    await expect(page.locator('[data-task-bar="ENG-201"]')).toBeVisible();
    await expect(page.locator('[data-day-off]')).toHaveCount(0);
    const dayWidth = 28;
    expect(await barWidth('ENG-201')).toBeCloseTo(3 * dayWidth, 0); // Mon–Wed
    expect(await barWidth('ENG-202')).toBeCloseTo(3 * dayWidth, 0); // Wed–Fri

    // 1. Company-wide day off
    await addDayOffViaDialog(page, { label: 'Company Retreat', start: isoOffsetDays(wed) });
    expect(entries).toEqual([
      expect.objectContaining({
        label: 'Company Retreat',
        startDate: isoOffsetDays(wed),
        endDate: isoOffsetDays(wed),
        assigneeName: null,
      }),
    ]);

    // Shaded on every row and in the date ruler, with the entry name on hover
    for (const id of ['ENG-201', 'ENG-202', 'ENG-203']) {
      const shade = page.locator(`tr[data-task-id="${id}"] [data-day-off="Company Retreat"]`);
      await expect(shade).toHaveCount(1);
      await expect(shade).toHaveAttribute('data-day-off-scope', 'company');
      await expect(shade).toHaveAttribute('title', /Company Retreat/);
    }
    const headerShade = page.locator('[data-header-day-off="Company Retreat"]');
    await expect(headerShade).toHaveCount(1);
    await expect(headerShade).toHaveAttribute('title', 'Company Retreat');

    // Two tasks were snapped, saved to Linear, and announced with an Undo
    await expect(page.getByText('Company Retreat added: moved 2 tasks to the next workday')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect.poll(() => dueUpdates).toEqual([{ id: 'uuid-201', dueDate: isoOffsetDays(thu) }]);
    await expect.poll(() => startUpdates.map((u) => u.id)).toEqual(['uuid-202']);
    expect(startUpdates[0].body).toContain(`start: ${isoOffsetDays(thu)}`);
    await expect.poll(() => barWidth('ENG-201')).toBeCloseTo(4 * dayWidth, 0); // Mon–Thu
    await expect.poll(() => barWidth('ENG-202')).toBeCloseTo(2 * dayWidth, 0); // Thu–Fri
    expect(await barWidth('ENG-203')).toBeCloseTo(2 * dayWidth, 0);

    // 2. One person's day off for Nate on Thu: only Nate's tasks are affected
    await addDayOffViaDialog(page, { label: 'Nate Out', start: isoOffsetDays(thu), person: 'Nate Jones' });
    expect(entries[1]).toMatchObject({ label: 'Nate Out', assigneeName: 'Nate Jones' });

    for (const id of ['ENG-202', 'ENG-203']) {
      const shade = page.locator(`tr[data-task-id="${id}"] [data-day-off="Nate Out"]`);
      await expect(shade).toHaveCount(1);
      await expect(shade).toHaveAttribute('data-day-off-scope', 'person');
      await expect(shade).toHaveAttribute('title', /Nate Out · Nate Jones out/);
    }
    await expect(page.locator('tr[data-task-id="ENG-201"] [data-day-off="Nate Out"]')).toHaveCount(0);
    // A per-person day off is not company-wide, so the date ruler does not mark it
    await expect(page.locator('[data-header-day-off]')).toHaveCount(1);

    // ENG-202 started on Thu (snapped earlier), now Nate's day off: Thu -> Fri
    await expect(page.getByText('Nate Out added: moved 1 task to the next workday')).toBeVisible();
    await expect.poll(() => startUpdates.map((u) => u.id)).toEqual(['uuid-202', 'uuid-202']);
    expect(startUpdates[1].body).toContain(`start: ${isoOffsetDays(fri)}`);
    expect(dueUpdates).toEqual([{ id: 'uuid-201', dueDate: isoOffsetDays(thu) }]); // Andrew's task is untouched
    await expect.poll(() => barWidth('ENG-202')).toBeCloseTo(1 * dayWidth, 0); // Fri only

    expect(errors).toEqual([]);
  });

  test('undoes the auto-snap, lists and removes entries, and leaves an add with nothing to snap quiet', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const mon = mondayOffset();
    const wed = mon + 2;

    const { dueUpdates } = await mockLinearIssues(page, [
      {
        id: 'uuid-211',
        identifier: 'ENG-211',
        title: 'Due on holiday',
        assignee: 'Andrew Phillips',
        startOffset: mon,
        dueOffset: wed,
      },
    ]);
    const entries = await mockDaysOffApi(page);

    await page.goto('/app');
    const bar = page.locator('[data-task-bar="ENG-211"]');
    await expect(bar).toBeVisible();

    // Nothing lands on a far-away holiday: a plain confirmation, no snapping
    await addDayOffViaDialog(page, {
      label: 'Far Future',
      start: isoOffsetDays(mon + 40),
      end: isoOffsetDays(mon + 41),
    });
    await expect(page.getByText('Added Far Future')).toBeVisible();
    expect(dueUpdates).toEqual([]);

    await addDayOffViaDialog(page, { label: 'Retreat', start: isoOffsetDays(wed) });
    await expect.poll(() => dueUpdates.length).toBe(1);
    await expect.poll(async () => (await bar.boundingBox())!.width).toBeCloseTo(4 * 28, 0);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Undone')).toHaveCount(0); // the toast action, not Ctrl+Z, so no extra toast
    await expect.poll(async () => (await bar.boundingBox())!.width).toBeCloseTo(3 * 28, 0);
    await expect.poll(() => dueUpdates.length).toBe(2);
    expect(dueUpdates[1]).toEqual({ id: 'uuid-211', dueDate: isoOffsetDays(wed) });

    // The manager lists both entries; removing one clears its shading
    await openDaysOffDialog(page);
    const dialog = page.getByRole('dialog', { name: 'Days Off' });
    await expect(dialog.locator('[data-day-off-entry]')).toHaveCount(2);
    await expect(dialog.locator('[data-day-off-entry="Far Future"]')).toContainText(' – ');
    await dialog.getByRole('button', { name: 'Remove Retreat' }).click();
    await expect(dialog.locator('[data-day-off-entry="Retreat"]')).toHaveCount(0);
    await expect.poll(() => entries.map((e) => e.label)).toEqual(['Far Future']);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-day-off="Retreat"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('validates the Days Off form before saving', async ({ page }) => {
    const errors = trackErrors(page);
    const mon = mondayOffset();
    await mockLinearIssues(
      page,
      [
        {
          id: 'uuid-221',
          identifier: 'ENG-221',
          title: 'Any task',
          assignee: 'Andrew Phillips',
          startOffset: mon,
          dueOffset: mon + 1,
        },
      ],
      { id: 'usr-1', name: '' },
    );
    const entries = await mockDaysOffApi(page);

    await page.goto('/app');
    await expect(page.locator('[data-task-bar="ENG-221"]')).toBeVisible();
    await expect(page.getByTitle('Account')).toContainText('?');
    await openDaysOffDialog(page);
    const dialog = page.getByRole('dialog', { name: 'Days Off' });
    const add = dialog.getByRole('button', { name: 'Add', exact: true });

    await add.click();
    await expect(dialog.getByRole('alert')).toContainText('Give the entry a name');

    await dialog.getByLabel('Name', { exact: true }).fill('Trip');
    await add.click();
    await expect(dialog.getByRole('alert')).toContainText('valid start date');

    await dialog.getByLabel('Start date', { exact: true }).fill(isoOffsetDays(mon + 5));
    await dialog.getByLabel('Applies to', { exact: true }).selectOption('person');
    await add.click();
    await expect(dialog.getByRole('alert')).toContainText('Pick or type the person');
    expect(entries).toEqual([]);

    // Keyboard shortcuts stay quiet while the dialog is open, and Escape closes it
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('skips days off when moving bars and counting workdays in the detail panel', async ({ page }) => {
    const errors = trackErrors(page);
    const mon = mondayOffset();
    const wed = mon + 2;

    const { dueUpdates, startUpdates } = await mockLinearIssues(page, [
      // 2 workdays, moved 2 days right: Wed is a holiday so it runs Thu–Fri
      {
        id: 'uuid-231',
        identifier: 'ENG-231',
        title: 'Drag me',
        assignee: 'Andrew Phillips',
        startOffset: mon,
        dueOffset: mon + 1,
      },
      // Mon–Fri around the Wed holiday: 4 workdays
      {
        id: 'uuid-232',
        identifier: 'ENG-232',
        title: 'Spans holiday',
        assignee: 'Andrew Phillips',
        startOffset: mon,
        dueOffset: mon + 4,
      },
      // Same span for Nate, who is also out Tue: 3 workdays
      {
        id: 'uuid-233',
        identifier: 'ENG-233',
        title: 'Spans person day off',
        assignee: 'Nate Jones',
        startOffset: mon,
        dueOffset: mon + 4,
      },
    ]);
    await mockDaysOffApi(page, [
      {
        id: 'h1',
        label: 'Company Retreat',
        startDate: isoOffsetDays(wed),
        endDate: isoOffsetDays(wed),
        assigneeName: null,
      },
      {
        id: 'p1',
        label: 'Nate Out',
        startDate: isoOffsetDays(mon + 1),
        endDate: isoOffsetDays(mon + 1),
        assigneeName: 'Nate Jones',
      },
    ]);

    await page.goto('/app');
    const bar = page.locator('[data-task-bar="ENG-231"]');
    await expect(bar).toBeVisible();
    await expect(page.locator('tr[data-task-id="ENG-233"] [data-day-off="Nate Out"]')).toHaveCount(1);

    // Duration in the detail panel excludes the company-wide day off, and Nate's own only for Nate
    await page.locator('[data-task-bar="ENG-232"]').click();
    await expect(page.getByText('4 workdays')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('4 workdays')).toHaveCount(0);
    await page.locator('[data-task-bar="ENG-233"]').click();
    await expect(page.getByText('3 workdays')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('3 workdays')).toHaveCount(0);

    // Dragging Mon–Tue two days right lands the start on the holiday, so it snaps to Thu and ends Fri
    const box = (await bar.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 56, startY, { steps: 4 });
    // The live preview already shows the calendar-aware result
    await expect(bar).toContainText('(2wd)');
    await page.mouse.up();

    await expect.poll(() => dueUpdates).toEqual([{ id: 'uuid-231', dueDate: isoOffsetDays(mon + 4) }]);
    await expect.poll(() => startUpdates.length).toBe(1);
    expect(startUpdates[0].body).toContain(`start: ${isoOffsetDays(mon + 3)}`);

    expect(errors).toEqual([]);
  });

  test('shares the days off calendar through the server API', async ({ request, baseURL }) => {
    const origin = baseURL ?? 'http://127.0.0.1:4173';
    const headers = { origin, 'content-type': 'application/json' };
    const label = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const created = await request.post('/api/days-off', {
      headers,
      data: { label, startDate: '2099-11-26', endDate: '2099-11-27', assigneeName: 'Alex Rivera' },
    });
    expect(created.status()).toBe(201);
    const { dayOff } = (await created.json()) as { dayOff: DayOffEntry };
    expect(dayOff).toMatchObject({
      label,
      startDate: '2099-11-26',
      endDate: '2099-11-27',
      assigneeName: 'Alex Rivera',
    });

    try {
      const listed = await request.get('/api/days-off');
      expect(((await listed.json()) as { daysOff: DayOffEntry[] }).daysOff).toContainEqual(dayOff);

      const bad = await request.post('/api/days-off', { headers, data: { label, startDate: '2099-02-31' } });
      expect(bad.status()).toBe(400);
      const crossOrigin = await request.post('/api/days-off', {
        headers: { ...headers, origin: 'https://evil.example.com' },
        data: { label, startDate: '2099-11-26' },
      });
      expect(crossOrigin.status()).toBe(403);
    } finally {
      const removed = await request.delete(`/api/days-off/${dayOff.id}`, { headers });
      expect(removed.status()).toBe(200);
    }
    const gone = await request.delete(`/api/days-off/${dayOff.id}`, { headers });
    expect(gone.status()).toBe(404);
  });

  test('keeps the previous /api/non-work-days path working as an alias', async ({ request, baseURL }) => {
    const origin = baseURL ?? 'http://127.0.0.1:4173';
    const headers = { origin, 'content-type': 'application/json' };
    const label = `e2e-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const created = await request.post('/api/non-work-days', {
      headers,
      data: { label, startDate: '2099-11-26', endDate: '2099-11-27' },
    });
    expect(created.status()).toBe(201);
    const { nonWorkDay } = (await created.json()) as { nonWorkDay: DayOffEntry };
    expect(nonWorkDay).toMatchObject({ label, startDate: '2099-11-26', endDate: '2099-11-27', assigneeName: null });

    try {
      const legacy = await request.get('/api/non-work-days');
      expect(((await legacy.json()) as { nonWorkDays: DayOffEntry[] }).nonWorkDays).toContainEqual(nonWorkDay);
      // Same calendar through the new path
      const current = await request.get('/api/days-off');
      expect(((await current.json()) as { daysOff: DayOffEntry[] }).daysOff).toContainEqual(nonWorkDay);
    } finally {
      const removed = await request.delete(`/api/non-work-days/${nonWorkDay.id}`, { headers });
      expect(removed.status()).toBe(200);
    }
  });
});
