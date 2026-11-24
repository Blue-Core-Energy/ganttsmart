import { expect, test } from '@playwright/test';
import {
  blockFonts,
  createScheduleMock,
  isoOffsetDays,
  localOffsetDate,
  mockLinearIssues,
  startTagOffsetDays,
  trackErrors,
} from './helpers/index.js';

let defaultScheduleMock = createScheduleMock();

test.describe('GanttSmart GCP app', () => {
  test.beforeEach(async ({ page }) => {
    defaultScheduleMock = createScheduleMock();
    await blockFonts(page);
  });

  test('preserves workday duration and skips weekends when moving a task bar across weekends', async ({ page }) => {
    const errors = trackErrors(page);
    const today = localOffsetDate(0);
    const monOffset = (8 - today.getDay()) % 7;
    const friOffset = monOffset + 4;
    const wedOffset = monOffset + 2;
    const tueNextOffset = monOffset + 8;

    const initialDescription = `${startTagOffsetDays(monOffset)}\nWeekly build`;
    const dueUpdates: string[] = [];
    const descUpdates: string[] = [];
    const schedule = createScheduleMock({ description: initialDescription, dueDate: isoOffsetDays(friOffset) });

    await page.addInitScript(() => {
      localStorage.setItem('gantt_onboarding_done', '1');
      localStorage.setItem('gantt_theme', 'dark');
      localStorage.setItem('linear_selected_project', 'proj-1');
    });

    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'dev@bluecore.energy', linearConnected: true }),
      });
    });

    await page.route('**/api/linear/graphql', async (route) => {
      const payload = route.request().postDataJSON() as {
        query?: string;
        variables?: { id?: string; dueDate?: string; description?: string };
      } | null;
      const query = payload?.query ?? '';
      if (await schedule.handle(route, payload)) return;

      if (query.includes('projects(')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { projects: { nodes: [{ id: 'proj-1', name: 'Demo Project' }] } },
          }),
        });
        return;
      }

      if (query.includes('externalLinks')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { project: { url: 'https://linear.app/bluecoreenergy/project/demo', externalLinks: { nodes: [] } } },
          }),
        });
        return;
      }

      if (query.includes('project(id:')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              project: {
                name: 'Demo Project',
                startDate: isoOffsetDays(monOffset - 2),
                targetDate: isoOffsetDays(tueNextOffset + 5),
                projectMilestones: { nodes: [] },
                issues: {
                  nodes: [
                    {
                      id: 'uuid-1',
                      identifier: 'ENG-101',
                      title: 'Assemble test harness',
                      description: initialDescription,
                      dueDate: isoOffsetDays(friOffset),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-101',
                      priority: 2,
                      state: { name: 'Todo', type: 'unstarted' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Andrew Phillips' },
                      team: { id: 'team-1' },
                      projectMilestone: null,
                    },
                  ],
                },
                doneIssues: { nodes: [] },
              },
            },
          }),
        });
        return;
      }

      if (query.includes('relations')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { issues: { nodes: [] } } }),
        });
        return;
      }

      if (query.includes('workflowStates')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { workflowStates: { nodes: [{ id: 'st-1', name: 'Todo', type: 'unstarted', position: 0 }] } },
          }),
        });
        return;
      }

      if (query.includes('issueUpdate')) {
        if (payload?.variables?.dueDate) dueUpdates.push(payload.variables.dueDate);
        if (payload?.variables?.description) descUpdates.push(payload.variables.description);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { issueUpdate: { success: true } } }),
        });
        return;
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');
    const bar = page.locator('[data-task-bar="ENG-101"]');
    await expect(bar).toBeVisible();

    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;

    // Move Mon->Fri task (5 workdays) 2 days right (DEFAULT_DAY_WIDTH = 28 -> 56px) -> Wed->Tue
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 56, startY, { steps: 4 });
    await page.mouse.up();

    await expect.poll(() => dueUpdates.length).toBe(1);
    await expect.poll(() => schedule.state.creates.length + schedule.state.updates.length).toBe(1);

    expect(dueUpdates[0]).toBe(isoOffsetDays(tueNextOffset));
    // Both dates land in one schedule comment written atomically; the description is untouched
    expect(schedule.state.comments).toHaveLength(1);
    expect(schedule.state.comments[0].body).toBe(
      `**GanttSmart Schedule**\nstart: ${isoOffsetDays(wedOffset)}\nend: ${isoOffsetDays(tueNextOffset)}`,
    );
    expect(descUpdates).toEqual([]);

    // DetailPanel reflects the preserved 5-workday duration
    await bar.click();
    await expect(page.getByText('5 workdays')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('zooms anchored under pointer via Ctrl+wheel, switches granularity, and pans by dragging background', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const updatedDates: string[] = [];
    const schedule = createScheduleMock({ description: `${startTagOffsetDays(-5)}\nDesign` });

    await page.addInitScript(() => {
      localStorage.setItem('gantt_onboarding_done', '1');
      localStorage.setItem('gantt_theme', 'dark');
      localStorage.setItem('linear_selected_project', 'proj-1');
    });

    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'dev@bluecore.energy', linearConnected: true }),
      });
    });

    await page.route('**/api/linear/graphql', async (route) => {
      const payload = route.request().postDataJSON() as {
        query?: string;
        variables?: { input?: { dueDate?: string } };
      } | null;
      const query = payload?.query ?? '';
      if (await schedule.handle(route, payload)) return;

      if (query.includes('projects(')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { projects: { nodes: [{ id: 'proj-1', name: 'Demo Project' }] } } }),
        });
        return;
      }

      if (query.includes('project(id:')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              project: {
                name: 'Demo Project',
                startDate: isoOffsetDays(-10),
                targetDate: isoOffsetDays(60),
                projectMilestones: { nodes: [] },
                issues: {
                  nodes: [
                    {
                      id: 'uuid-1',
                      identifier: 'ENG-101',
                      title: 'Early design',
                      description: `${startTagOffsetDays(-5)}\nDesign`,
                      dueDate: isoOffsetDays(2),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-101',
                      priority: 2,
                      state: { name: 'In Progress', type: 'started' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Andrew Phillips' },
                      team: { id: 'team-1' },
                      projectMilestone: null,
                    },
                    {
                      id: 'uuid-2',
                      identifier: 'ENG-102',
                      title: 'Long integration',
                      description: `${startTagOffsetDays(6)}\nIntegration`,
                      dueDate: isoOffsetDays(26),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-102',
                      priority: 3,
                      state: { name: 'Todo', type: 'unstarted' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Nate Jones' },
                      team: { id: 'team-1' },
                      projectMilestone: null,
                    },
                  ],
                },
                doneIssues: { nodes: [] },
              },
            },
          }),
        });
        return;
      }

      if (query.includes('relations')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: 'uuid-1',
                    identifier: 'ENG-101',
                    relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ENG-102' } }] },
                    children: { nodes: [] },
                  },
                  {
                    id: 'uuid-2',
                    identifier: 'ENG-102',
                    relations: { nodes: [{ type: 'blocked_by', relatedIssue: { identifier: 'ENG-101' } }] },
                    children: { nodes: [] },
                  },
                ],
              },
            },
          }),
        });
        return;
      }

      if (query.includes('workflowStates')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              workflowStates: {
                nodes: [
                  { id: 'st-1', name: 'Todo', type: 'unstarted', position: 0 },
                  { id: 'st-2', name: 'In Progress', type: 'started', position: 1 },
                ],
              },
            },
          }),
        });
        return;
      }

      if (query.includes('issueUpdate')) {
        updatedDates.push(payload?.variables?.input?.dueDate ?? '');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { issueUpdate: { success: true, issue: { id: 'uuid-1', dueDate: isoOffsetDays(4) } } },
          }),
        });
        return;
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');
    const bar1 = page.locator('[data-task-bar="ENG-101"]');
    await expect(bar1).toBeVisible();

    const scroller = page.locator('#gantt-export-target');

    // 1. Background drag pans the timeline horizontally (click empty area to the right of ENG-101's bar, inside viewport)
    const bgCell = page.locator('tr[data-task-id="ENG-101"] [data-timeline-background]').first();
    const bgBox = (await bgCell.boundingBox())!;
    const b1Init = (await bar1.boundingBox())!;
    const panStartX = Math.min(b1Init.x + b1Init.width + 220, 1180);
    const panY = bgBox.y + bgBox.height / 2;

    const initialScroll = await scroller.evaluate((el) => el.scrollLeft);
    await page.mouse.move(panStartX, panY);
    await page.mouse.down();
    await page.mouse.move(panStartX - 240, panY, { steps: 8 });
    await page.mouse.up();
    const pannedScroll = await scroller.evaluate((el) => el.scrollLeft);
    expect(pannedScroll).toBeGreaterThan(initialScroll + 150);

    // 2. Ctrl+wheel zooms anchored under the pointer (pick a visible point inside ENG-102)
    const bar2 = page.locator('[data-task-bar="ENG-102"]');
    const bar2Before = (await bar2.boundingBox())!;
    const anchorX = Math.min(Math.max(bar2Before.x + 80, 680), 1180);
    const anchorY = bar2Before.y + bar2Before.height / 2;
    const ratioBefore = (anchorX - bar2Before.x) / bar2Before.width;

    await page.mouse.move(anchorX, anchorY);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -180);
    await page.keyboard.up('Control');

    const bar2AfterZoomIn = (await bar2.boundingBox())!;
    expect(bar2AfterZoomIn.width).toBeGreaterThan(bar2Before.width * 1.15);
    // The same fractional point inside ENG-102 stays right under the pointer
    const ratioAfter = (anchorX - bar2AfterZoomIn.x) / bar2AfterZoomIn.width;
    expect(ratioAfter).toBeCloseTo(ratioBefore, 1);

    // 3. Zooming out smoothly switches header granularity day -> week -> month
    const timelineHeader = page.locator('#gantt-export-target thead th').last();
    // Day scale shows weekday abbreviations beneath each day number
    await expect(timelineHeader).toContainText(/\d+(Mo|Tu|We|Th|Fr|Sa|Su)/);

    await page.keyboard.down('Control');
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 220);
    }
    await page.keyboard.up('Control');

    // Now in week or month scale: day-of-week sub-labels disappear
    await expect(timelineHeader).not.toContainText(/\d+(Mo|Tu|We|Th|Fr|Sa|Su)/);

    // Zoom out further to month scale (top header becomes 4-digit year only)
    await page.keyboard.down('Control');
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 250);
    }
    await page.keyboard.up('Control');
    const topHeaderRow = timelineHeader.locator('> div').first();
    await expect(topHeaderRow).toContainText(/^\s*\d{4}(\s*\d{4})*\s*$/);

    // At minimum zoom, the floating narrow-bar label sits clear of the 20px-floor bar
    const minZoomBar1 = (await bar1.boundingBox())!;
    const minZoomLabel = page.locator('tr[data-task-id="ENG-101"] td:last-child > div > span.pointer-events-none');
    await expect(minZoomLabel).toBeVisible();
    const minZoomLabelBox = (await minZoomLabel.boundingBox())!;
    expect(minZoomLabelBox.x).toBeGreaterThanOrEqual(minZoomBar1.x + minZoomBar1.width);

    // Zoom back in with '+' keyboard shortcut to return to day scale
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('+');
    }
    await expect(timelineHeader).toContainText(/\d+(Mo|Tu|We|Th|Fr|Sa|Su)/);

    // 4. Ctrl+wheel over the fixed Issue column does not jump scrollLeft, and clamping at max zoom leaves no stale anchor
    await scroller.evaluate((el) => {
      el.scrollLeft = 0;
    });
    const taskCell = page.locator('tr[data-task-id="ENG-101"] td[data-column-key="task"]');
    const taskBox = (await taskCell.boundingBox())!;
    await page.mouse.move(taskBox.x + 80, taskBox.y + taskBox.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -180);
    await page.keyboard.up('Control');
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(0);

    // Reach max zoom, fire another zoom-in wheel, then resize a column — scrollLeft stays 0
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('+');
    }
    await page.mouse.move(anchorX, anchorY);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -240);
    await page.keyboard.up('Control');
    const firstHeader = page.locator('#gantt-export-target thead th').first();
    const hBox = (await firstHeader.boundingBox())!;
    await page.mouse.move(hBox.x + hBox.width - 2, hBox.y + hBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(hBox.x + hBox.width + 20, hBox.y + hBox.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(0);

    // Return near default zoom and verify dragging a task bar still reschedules instead of panning
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('-');
    }
    await scroller.evaluate((el) => {
      el.scrollLeft = 0;
    });
    const b1 = (await bar1.boundingBox())!;
    const scrollBeforeBarDrag = await scroller.evaluate((el) => el.scrollLeft);
    await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
    await page.mouse.down();
    await page.mouse.move(b1.x + b1.width / 2 + 56, b1.y + b1.height / 2, { steps: 6 });
    await page.mouse.up();
    const scrollAfterBarDrag = await scroller.evaluate((el) => el.scrollLeft);
    expect(scrollAfterBarDrag).toBe(scrollBeforeBarDrag);
    await expect.poll(() => updatedDates.length).toBeGreaterThan(0);

    // IT-142: Zooming out and back in must not leave high-water mark / dead space past the end of the calendar.
    // Also verify dependency arrows are mounted and remain visible across shrinking.
    const depArrow = page.locator('svg path[data-arrow-source="ENG-101"][data-arrow-target="ENG-102"]');
    await expect(depArrow).toBeVisible();

    const initialDiff = await page.evaluate(() => {
      const container = document.getElementById('gantt-export-target')!;
      const table = container.querySelector('table')!;
      return Math.abs(container.scrollWidth - Math.max(table.offsetWidth, container.clientWidth));
    });
    expect(initialDiff).toBeLessThanOrEqual(2);

    // Zoom out deeply (multi-step wheel zoom out)
    await page.keyboard.down('Control');
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 300);
    }
    await page.keyboard.up('Control');

    // Zoom back in to day scale
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('+');
    }
    await expect(timelineHeader).toContainText(/\d+(Mo|Tu|We|Th|Fr|Sa|Su)/);

    // After zooming back in, scrollWidth must shrink back to match Math.max(table.offsetWidth, container.clientWidth)
    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const container = document.getElementById('gantt-export-target')!;
          const table = container.querySelector('table')!;
          return Math.abs(container.scrollWidth - Math.max(table.offsetWidth, container.clientWidth));
        });
      })
      .toBeLessThanOrEqual(2);

    // Dependency arrows still render and stay visible after shrinking
    await expect(depArrow).toBeVisible();

    // Zoom way in to wide day scale (widening the table), then zoom back out
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('+');
    }
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('-');
    }

    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          const container = document.getElementById('gantt-export-target')!;
          const table = container.querySelector('table')!;
          return Math.abs(container.scrollWidth - Math.max(table.offsetWidth, container.clientWidth));
        });
      })
      .toBeLessThanOrEqual(2);

    await expect(depArrow).toBeVisible();

    // Scrolling to the right edge leaves the last day visible with no empty dead space past the table
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const rightEdgeState = await page.evaluate(() => {
      const container = document.getElementById('gantt-export-target')!;
      const table = container.querySelector('table')!;
      const containerRect = container.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      // Table's right edge should be at or within 2px of container's right edge (no empty space to the right)
      return { tableRight: tableRect.right, containerRight: containerRect.right };
    });
    expect(rightEdgeState.tableRight).toBeGreaterThanOrEqual(rightEdgeState.containerRight - 2);

    expect(errors).toEqual([]);
  });

  test('date range picker keeps month arrows beside the caption and fits narrow viewports', async ({ page }) => {
    const errors = trackErrors(page);

    await page.addInitScript(() => {
      localStorage.setItem('gantt_onboarding_done', '1');
      localStorage.setItem('gantt_theme', 'dark');
      localStorage.setItem('linear_selected_project', 'proj-1');
    });

    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'dev@bluecore.energy', linearConnected: true }),
      });
    });

    await page.route('**/api/linear/graphql', async (route) => {
      const payload = route.request().postDataJSON() as { query?: string } | null;
      const query = payload?.query ?? '';
      if (await defaultScheduleMock.handle(route, payload)) return;

      if (query.includes('projects(')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { projects: { nodes: [{ id: 'proj-1', name: 'Demo Project' }] } },
          }),
        });
        return;
      }

      if (query.includes('project(id:')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              project: {
                name: 'Demo Project',
                startDate: isoOffsetDays(-10),
                targetDate: isoOffsetDays(20),
                projectMilestones: {
                  nodes: [
                    {
                      id: 'ms-1',
                      name: 'Beta Release',
                      description: 'Initial milestone',
                      targetDate: isoOffsetDays(10),
                      sortOrder: 1,
                      createdAt: '2026-01-01T00:00:00Z',
                      updatedAt: '2026-01-02T00:00:00Z',
                    },
                  ],
                },
                issues: {
                  nodes: [
                    {
                      id: 'uuid-1',
                      identifier: 'ENG-101',
                      title: 'Design valve manifold',
                      description: `${startTagOffsetDays(-2)}\nManifold details`,
                      dueDate: isoOffsetDays(5),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-101',
                      priority: 2,
                      state: { name: 'In Progress', type: 'started' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Andrew Phillips' },
                      team: { id: 'team-1' },
                      projectMilestone: { id: 'ms-1' },
                    },
                    {
                      id: 'uuid-2',
                      identifier: 'ENG-102',
                      title: 'Pressure test rig',
                      description: `${startTagOffsetDays(1)}\nTest details`,
                      dueDate: isoOffsetDays(9),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-102',
                      priority: 3,
                      state: { name: 'Todo', type: 'unstarted' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Nate Jones' },
                      team: { id: 'team-1' },
                      projectMilestone: null,
                    },
                  ],
                },
                doneIssues: { nodes: [] },
              },
            },
          }),
        });
        return;
      }

      if (query.includes('relations')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: 'uuid-1',
                    identifier: 'ENG-101',
                    relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ENG-102' } }] },
                    children: { nodes: [] },
                  },
                  {
                    id: 'uuid-2',
                    identifier: 'ENG-102',
                    relations: { nodes: [{ type: 'blocked_by', relatedIssue: { identifier: 'ENG-101' } }] },
                    children: { nodes: [] },
                  },
                ],
              },
            },
          }),
        });
        return;
      }

      if (query.includes('workflowStates')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              workflowStates: {
                nodes: [
                  { id: 'st-1', name: 'Todo', type: 'unstarted', position: 0 },
                  { id: 'st-2', name: 'In Progress', type: 'started', position: 1 },
                  { id: 'st-3', name: 'Done', type: 'completed', position: 2 },
                ],
              },
            },
          }),
        });
        return;
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();

    const popover = page.locator('[data-popover="date-range"]');
    const prev = page.getByRole('button', { name: /previous month/i });
    const next = page.getByRole('button', { name: /next month/i });

    const openDesktopPicker = async () => {
      await page.getByTestId('column-filter-due').click();
      await expect(popover).toBeVisible();
    };

    const openMobilePicker = async () => {
      await page
        .getByTestId('filter-bar')
        .getByRole('button', { name: /Filter/ })
        .click();
      await page.getByRole('button', { name: 'Date range' }).click();
      await expect(popover).toBeVisible();
    };

    /** Geometry of the nav row against the day grid it must not sit inside */
    const layout = async () =>
      popover.evaluate((pop) => {
        const days = [...pop.querySelectorAll('button')].filter((b) => /^\d+$/.test(b.textContent?.trim() ?? ''));
        const firstDay = days[0].getBoundingClientRect();
        const box = (el: Element) => el.getBoundingClientRect();
        const navButtons = [...pop.querySelectorAll('button')].filter((b) =>
          /previous|next/i.test(b.getAttribute('aria-label') ?? ''),
        );
        return {
          popLeft: box(pop).left,
          popRight: box(pop).right,
          noHorizontalScroll: pop.scrollWidth <= pop.clientWidth,
          gridTop: firstDay.top,
          gridLeft: firstDay.left,
          navBottom: Math.max(...navButtons.map((b) => box(b).bottom)),
          prevRight: box(navButtons[0]).right,
          nextLeft: box(navButtons[1]).left,
        };
      });

    // Desktop: two months, arrows flanking the captions above the grid
    await openDesktopPicker();
    const desktop = await layout();
    expect(desktop.noHorizontalScroll).toBe(true);
    // The nav sits above the day grid rather than stacked inside it
    expect(desktop.navBottom).toBeLessThanOrEqual(desktop.gridTop);
    // ...with previous on the left edge and next out past the second month
    expect(desktop.prevRight).toBeLessThanOrEqual(desktop.gridLeft + 40);
    expect(desktop.nextLeft).toBeGreaterThan(desktop.gridLeft + 400);

    // Arrows still navigate
    const caption = popover
      .locator('div')
      .filter({ hasText: /^[A-Z][a-z]+ \d{4}$/ })
      .first();
    const firstCaption = (await caption.textContent())!.trim();
    await next.click();
    await expect(caption).not.toHaveText(firstCaption);
    await prev.click();
    await expect(caption).toHaveText(firstCaption);

    // Narrow viewport: one month, no horizontal scroll, inside the viewport
    await page.setViewportSize({ width: 375, height: 760 });
    // Escape closes the desktop popover
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await openMobilePicker();
    const mobile = await layout();
    expect(mobile.noHorizontalScroll).toBe(true);
    expect(mobile.navBottom).toBeLessThanOrEqual(mobile.gridTop);
    expect(mobile.popLeft).toBeGreaterThanOrEqual(0);
    expect(mobile.popRight).toBeLessThanOrEqual(375);

    // Month arrows still navigate on mobile
    const mobileCaption = popover
      .locator('div')
      .filter({ hasText: /^[A-Z][a-z]+ \d{4}$/ })
      .first();
    const firstMobileCaption = (await mobileCaption.textContent())!.trim();
    await next.click();
    await expect(mobileCaption).not.toHaveText(firstMobileCaption);
    await prev.click();
    await expect(mobileCaption).toHaveText(firstMobileCaption);

    expect(errors).toEqual([]);
  });

  test('marks today with a soft column highlight without a dashed border, and keeps vertical line at week/month scale', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await mockLinearIssues(page, [
      {
        id: 'uuid-101',
        identifier: 'ENG-101',
        title: 'Task spanning today',
        assignee: 'Andrew Phillips',
        startOffset: -3,
        dueOffset: 5,
      },
    ]);

    await page.goto('/app');
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();

    // 1. At day scale: today's cell has the soft highlight and normal border, no dashed purple line
    const todayCell = page.locator('tr[data-task-id="ENG-101"] [data-today-cell="true"]');
    await expect(todayCell).toBeVisible();
    await expect(todayCell).toHaveClass(/bg-accent\/\[0\.08\]/);
    await expect(todayCell).toHaveClass(/border-border-primary\/30/);
    await expect(todayCell).not.toHaveClass(/border-dashed/);
    await expect(todayCell).not.toHaveClass(/border-accent/);

    // Date header cell aligns with the column highlight and also has no dashed border
    const todayHeader = page.locator('[data-header-current="true"]');
    await expect(todayHeader).toBeVisible();
    await expect(todayHeader).toHaveClass(/bg-accent\/\[0\.08\]/);
    await expect(todayHeader).not.toHaveClass(/border-dashed/);
    const headerBox = await todayHeader.boundingBox();
    const cellBox = await todayCell.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(cellBox).not.toBeNull();
    expect(Math.abs(headerBox!.x - cellBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(headerBox!.width - cellBox!.width)).toBeLessThanOrEqual(1);

    // 2. Zoom out to week scale: column highlight disappears, thin line appears
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('-');
    }
    await expect(page.locator('[data-today-line]').first()).toBeVisible();
    await expect(page.locator('[data-today-line]').first()).toHaveClass(/w-px bg-accent\/50/);
    await expect(page.locator('tr[data-task-id="ENG-101"] [data-today-cell="true"]')).toHaveCount(0);

    // Zoom out further to month scale: thin line is still rendered
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('-');
    }
    await expect(page.locator('[data-today-line]').first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('handles today falling on a weekend deliberately with today highlight taking precedence', async ({ page }) => {
    const errors = trackErrors(page);
    // Pick the upcoming Saturday relative to wall-clock time so task offsets and frozen clock stay aligned
    const now = localOffsetDate(0);
    const satOffset = (6 - now.getDay() + 7) % 7 || 7;
    const saturday = localOffsetDate(satOffset);
    await page.clock.setFixedTime(new Date(saturday.getFullYear(), saturday.getMonth(), saturday.getDate(), 12, 0, 0));

    await mockLinearIssues(page, [
      {
        id: 'uuid-101',
        identifier: 'ENG-101',
        title: 'Task spanning weekend today',
        assignee: 'Andrew Phillips',
        startOffset: satOffset - 2,
        dueOffset: satOffset + 4,
      },
    ]);

    await page.goto('/app');
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();

    // Today is Saturday: it must have bg-accent/[0.08] and NOT bg-bg-hover/30
    const todayCell = page.locator('tr[data-task-id="ENG-101"] [data-today-cell="true"]');
    await expect(todayCell).toBeVisible();
    await expect(todayCell).toHaveClass(/bg-accent\/\[0\.08\]/);
    await expect(todayCell).not.toHaveClass(/bg-bg-hover/);
    await expect(todayCell).not.toHaveClass(/border-dashed/);

    // Header cell also gets today highlight rather than weekend shading
    const todayHeader = page.locator('[data-header-current="true"]');
    await expect(todayHeader).toBeVisible();
    await expect(todayHeader).toHaveClass(/bg-accent\/\[0\.08\]/);
    await expect(todayHeader).not.toHaveClass(/bg-bg-hover/);

    expect(errors).toEqual([]);
  });
});
