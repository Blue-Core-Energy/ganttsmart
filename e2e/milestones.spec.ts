import { expect, test } from '@playwright/test';
import { blockFonts, createScheduleMock, isoOffsetDays, startTagOffsetDays, trackErrors } from './helpers/index.js';

let defaultScheduleMock = createScheduleMock();

test.describe('GanttSmart GCP app', () => {
  test.beforeEach(async ({ page }) => {
    defaultScheduleMock = createScheduleMock();
    await blockFonts(page);
  });

  test('keeps frozen cells opaque on completed rows and renders pinned milestone row with diamond interactions', async ({
    page,
  }) => {
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

    let updatedMilestoneTargetDate: string | null = null;

    await page.route('**/api/linear/graphql', async (route) => {
      const payload = route.request().postDataJSON() as {
        query?: string;
        variables?: Record<string, unknown>;
      } | null;
      if (await defaultScheduleMock.handle(route, payload)) return;
      const query = payload?.query ?? '';
      const json = (data: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });

      if (query.includes('projectMilestoneUpdate')) {
        updatedMilestoneTargetDate = (payload?.variables as { targetDate?: string } | undefined)?.targetDate ?? null;
        await json({ projectMilestoneUpdate: { success: true } });
        return;
      }

      if (query.includes('projects(')) {
        await json({ projects: { nodes: [{ id: 'proj-1', name: 'Demo Project' }] } });
        return;
      }

      if (query.includes('project(id:')) {
        await json({
          project: {
            name: 'Demo Project',
            startDate: isoOffsetDays(-10),
            targetDate: isoOffsetDays(90),
            projectMilestones: {
              nodes: [
                {
                  id: 'ms-1',
                  name: 'Beta Release',
                  description: 'Initial milestone',
                  targetDate: isoOffsetDays(5),
                  sortOrder: 1,
                  createdAt: '2026-01-01T00:00:00Z',
                  updatedAt: '2026-01-02T00:00:00Z',
                },
                {
                  id: 'ms-2',
                  name: 'RC1',
                  description: 'Release Candidate 1',
                  targetDate: isoOffsetDays(6),
                  sortOrder: 2,
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
                  dueDate: isoOffsetDays(30),
                  url: 'https://linear.app/bluecoreenergy/issue/ENG-101',
                  priority: 2,
                  state: { name: 'In Progress', type: 'started' },
                  createdAt: '2026-01-01T00:00:00Z',
                  completedAt: null,
                  assignee: { name: 'Andrew Phillips' },
                  team: { id: 'team-1' },
                  projectMilestone: null,
                },
                ...Array.from({ length: 24 }, (_, idx) => ({
                  id: `uuid-extra-${idx + 1}`,
                  identifier: `ENG-${102 + idx}`,
                  title: `Extra task ${idx + 1}`,
                  description: `${startTagOffsetDays(-2)}\nDetails`,
                  dueDate: isoOffsetDays(32 + idx),
                  url: `https://linear.app/bluecoreenergy/issue/ENG-${102 + idx}`,
                  priority: 2,
                  state: { name: 'In Progress', type: 'started' },
                  createdAt: '2026-01-01T00:00:00Z',
                  completedAt: null,
                  assignee: { name: 'Andrew Phillips' },
                  team: { id: 'team-1' },
                  projectMilestone: null,
                })),
              ],
            },
            doneIssues: {
              nodes: [
                {
                  id: 'uuid-done-1',
                  identifier: 'ENG-100',
                  title: 'Finalize CAD model',
                  description: `${startTagOffsetDays(-8)}\nCAD completed`,
                  dueDate: isoOffsetDays(20),
                  url: 'https://linear.app/bluecoreenergy/issue/ENG-100',
                  priority: 1,
                  state: { name: 'Done', type: 'completed' },
                  createdAt: '2026-01-01T00:00:00Z',
                  completedAt: '2026-01-05T12:00:00Z',
                  assignee: { name: 'Andrew Phillips' },
                  team: { id: 'team-1' },
                  projectMilestone: null,
                },
              ],
            },
          },
        });
        return;
      }

      if (query.includes('relations')) {
        await json({ issues: { nodes: [] } });
        return;
      }

      if (query.includes('workflowStates')) {
        await json({
          workflowStates: {
            nodes: [
              { id: 'st-1', name: 'Todo', type: 'unstarted', position: 0 },
              { id: 'st-2', name: 'In Progress', type: 'started', position: 1 },
              { id: 'st-3', name: 'Done', type: 'completed', position: 2 },
            ],
          },
        });
        return;
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/app');
    await expect(page.locator('[data-task-bar="ENG-100"]')).toBeVisible();

    const doneRow = page.locator('tr[data-task-id="ENG-100"]');
    await expect(doneRow).toHaveAttribute('data-task-done', 'true');
    const doneTaskCell = doneRow.locator('td[data-column-key="task"]');

    // Dashed vertical lines are removed; milestones render only on the pinned top row
    await expect(page.locator('[data-milestone-line]')).toHaveCount(0);

    const milestoneRow = page.locator('tr[data-milestone-row]');
    await expect(milestoneRow).toHaveCount(1);

    // Left frozen columns: "Milestones" in task column, other columns blank
    const milestoneTaskCell = milestoneRow.locator('td[data-column-key="task"]');
    await expect(milestoneTaskCell).toContainText('Milestones');
    const milestoneIdCell = milestoneRow.locator('td[data-column-key="id"]');
    expect((await milestoneIdCell.innerText()).trim()).toBe('');
    const milestoneDueCell = milestoneRow.locator('td[data-column-key="due"]');
    expect((await milestoneDueCell.innerText()).trim()).toBe('');

    // Milestone diamonds and labels on target dates
    const milestoneDiamond = page.locator('[data-milestone-diamond="ms-1"]');
    const milestoneDiamond2 = page.locator('[data-milestone-diamond="ms-2"]');
    await expect(milestoneDiamond).toBeVisible();
    await expect(milestoneDiamond2).toBeVisible();
    await expect(milestoneRow.getByText('Beta Release')).toBeVisible();
    await expect(milestoneRow.getByText('RC1')).toBeVisible();

    // Two nearby milestones stagger across two compact sub-row lanes (different Y coordinates)
    const d1InitialBox = (await milestoneDiamond.boundingBox())!;
    const d2InitialBox = (await milestoneDiamond2.boundingBox())!;
    expect(Math.abs(d2InitialBox.y - d1InitialBox.y)).toBeGreaterThan(15);

    // The row must not create a stacking context: opacity is applied to cell contents, never the row or cells
    await page.mouse.move(0, 0);
    const opacities = await doneRow.evaluate((row) => {
      const cell = row.querySelector('td[data-column-key="task"]') as HTMLElement;
      const chart = row.lastElementChild as HTMLElement;
      return {
        row: getComputedStyle(row).opacity,
        cell: getComputedStyle(cell).opacity,
        cellContent: getComputedStyle(cell.firstElementChild as HTMLElement).opacity,
        chartContent: getComputedStyle(chart.firstElementChild as HTMLElement).opacity,
      };
    });
    expect(opacities.row).toBe('1');
    expect(opacities.cell).toBe('1');
    expect(Number(opacities.cellContent)).toBeCloseTo(0.65, 2);
    expect(Number(opacities.chartContent)).toBeCloseTo(0.65, 2);

    // Hovering restores full contrast on the contents
    await doneTaskCell.hover();
    await expect
      .poll(async () => doneTaskCell.evaluate((el) => getComputedStyle(el.firstElementChild as HTMLElement).opacity))
      .toBe('1');

    // Vertical pinning: milestone row's sticky <td> cells stay pinned directly below the header while scrolling schedule
    const scrollContainer = page.locator('#gantt-export-target');
    const canScroll = await scrollContainer.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(canScroll).toBe(true);

    const theadTaskHeader = page.locator('#gantt-export-target thead th[data-column-key="task"]');
    const theadBottom = (await theadTaskHeader.boundingBox())!.y + (await theadTaskHeader.boundingBox())!.height;
    const milestoneTimelineCell = milestoneRow.locator('td').last();
    expect(Math.abs((await milestoneTaskCell.boundingBox())!.y - theadBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs((await milestoneTimelineCell.boundingBox())!.y - theadBottom)).toBeLessThanOrEqual(1);

    await scrollContainer.evaluate((el) => {
      el.scrollTop += 150;
    });
    expect(await scrollContainer.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(Math.abs((await milestoneTaskCell.boundingBox())!.y - theadBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs((await milestoneTimelineCell.boundingBox())!.y - theadBottom)).toBeLessThanOrEqual(1);

    await scrollContainer.evaluate((el) => {
      el.scrollTop = 0;
    });

    // Horizontal pinning: scroll horizontally until diamond sits under the frozen due column
    const cellBox = (await milestoneDueCell.boundingBox())!;
    const diamondBox = (await milestoneDiamond.boundingBox())!;
    const targetX = cellBox.x + cellBox.width / 2;
    await scrollContainer.evaluate((el, delta) => {
      el.scrollLeft += delta;
    }, diamondBox.x - targetX);
    await expect
      .poll(async () => Math.round((await milestoneDiamond.boundingBox())!.x))
      .toBeCloseTo(Math.round(targetX), -1);

    // Hit-testing respects paint order: frozen column sits above the scrolling diamond
    const hit = await page.evaluate(() => {
      const diamondEl = document.querySelector('[data-milestone-diamond="ms-1"]') as HTMLElement;
      const cell = document.querySelector('tr[data-milestone-row] td[data-column-key="due"]') as HTMLElement;
      const diamondRect = diamondEl.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      const x = diamondRect.left + diamondRect.width / 2;
      const y = diamondRect.top + diamondRect.height / 2;
      const top = document.elementFromPoint(x, y);
      return {
        diamondInsideCellBounds: x > cellRect.left && x < cellRect.right,
        yInsideCell: y > cellRect.top && y < cellRect.bottom,
        topIsDiamond: top === diamondEl || diamondEl.contains(top),
        topInCell: Boolean(top && cell.contains(top)),
      };
    });
    expect(hit.diamondInsideCellBounds).toBe(true);
    expect(hit.yInsideCell).toBe(true);
    expect(hit.topIsDiamond).toBe(false);
    expect(hit.topInCell).toBe(true);

    // Scroll back and click diamond to open milestone panel
    await scrollContainer.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await milestoneDiamond.click();
    await expect(page.getByText('Beta Release').first()).toBeVisible();
    await expect(page.getByText('Initial milestone')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Initial milestone')).toHaveCount(0);

    // Drag diamond horizontally to reschedule (drag left to stay well inside 1280px viewport)
    const dBox = (await milestoneDiamond.boundingBox())!;
    await page.mouse.move(dBox.x + dBox.width / 2, dBox.y + dBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dBox.x + dBox.width / 2 - 112, dBox.y + dBox.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => updatedMilestoneTargetDate).not.toBeNull();

    expect(errors).toEqual([]);
  });
});
