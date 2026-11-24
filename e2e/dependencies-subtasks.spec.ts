import { expect, test } from '@playwright/test';
import {
  blockFonts,
  createScheduleMock,
  isoOffsetDays,
  mockSubtaskProject,
  startTagOffsetDays,
  trackErrors,
} from './helpers/index.js';

let defaultScheduleMock = createScheduleMock();

test.describe('GanttSmart GCP app', () => {
  test.beforeEach(async ({ page }) => {
    defaultScheduleMock = createScheduleMock();
    await blockFonts(page);
  });

  test('hops a dependency arrow over an unrelated arrow it crosses', async ({ page }) => {
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

    const issue = (n: number, start: number, due: number) => ({
      id: `uuid-hop-${n}`,
      identifier: `HOP-${n}`,
      title: `Hop task ${n}`,
      description: `${startTagOffsetDays(start)}\nDetails`,
      dueDate: isoOffsetDays(due),
      url: `https://linear.app/bluecoreenergy/issue/HOP-${n}`,
      priority: 3,
      state: { name: 'Todo', type: 'unstarted' },
      createdAt: '2026-01-01T00:00:00Z',
      completedAt: null,
      assignee: { name: 'Andrew Phillips' },
      team: { id: 'team-1' },
      projectMilestone: null,
    });

    await page.route('**/api/linear/graphql', async (route) => {
      const payload = route.request().postDataJSON() as {
        query?: string;
        variables?: Record<string, unknown>;
      } | null;
      if (await defaultScheduleMock.handle(route, payload)) return;
      const query = payload?.query ?? '';
      const respond = (data: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });

      if (query.includes('projects(')) {
        await respond({ projects: { nodes: [{ id: 'proj-1', name: 'Hop Roadmap' }] } });
        return;
      }

      if (query.includes('project(id:')) {
        await respond({
          project: {
            name: 'Hop Roadmap',
            startDate: isoOffsetDays(-14),
            targetDate: isoOffsetDays(30),
            projectMilestones: { nodes: [] },
            issues: { nodes: [issue(1, -8, 8), issue(2, -8, 2), issue(3, 12, 16), issue(4, 12, 16)] },
            doneIssues: { nodes: [] },
          },
        });
        return;
      }

      if (query.includes('relations')) {
        // HOP-1 -> HOP-4 drops down a column that HOP-2 -> HOP-3's final approach runs straight across
        await respond({
          issues: {
            nodes: [
              {
                id: 'uuid-hop-1',
                identifier: 'HOP-1',
                relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'HOP-4' } }] },
                children: { nodes: [] },
              },
              {
                id: 'uuid-hop-2',
                identifier: 'HOP-2',
                relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'HOP-3' } }] },
                children: { nodes: [] },
              },
            ],
          },
        });
        return;
      }

      if (query.includes('workflowStates')) {
        await respond({
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

    await page.goto('/app');

    const exportTarget = page.locator('#gantt-export-target');
    const rows = exportTarget.locator('tbody tr[data-task-id]');
    await expect(rows).toHaveCount(4);
    const ids = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-task-id')));
    // Rows sort by due date, so the earlier-ending HOP-2 sits above HOP-1
    expect(ids).toEqual(['HOP-2', 'HOP-1', 'HOP-3', 'HOP-4']);

    const crossed = exportTarget.locator('svg path[data-arrow-source="HOP-1"][data-arrow-target="HOP-4"]');
    const crossing = exportTarget.locator('svg path[data-arrow-source="HOP-2"][data-arrow-target="HOP-3"]');
    await expect(crossed).toHaveCount(1);
    await expect(crossing).toHaveCount(1);

    // The dropping arrow bulges to the right over the line it crosses; the line itself stays flat
    await expect(crossed).toHaveAttribute('d', / A 4 4 0 0 1 [-\d.]+ [-\d.]+/);
    await expect(crossing).not.toHaveAttribute('d', /A /);

    // The hop is centred on the crossed line's row, and the click target follows the same path
    const crossedD = (await crossed.getAttribute('d'))!;
    const crossingD = (await crossing.getAttribute('d'))!;
    const hopY = Number(crossedD.match(/A 4 4 0 0 1 [-\d.]+ ([-\d.]+)/)![1]) - 4;
    const crossingY = Number(crossingD.match(/([-\d.]+) H [-\d.]+$/)![1]);
    expect(hopY).toBeCloseTo(crossingY, 0);
    await expect(exportTarget.locator('svg path[data-arrow-hit-target="HOP-1->HOP-4"]')).toHaveAttribute('d', crossedD);

    expect(errors).toEqual([]);
  });

  test('renders cross-project dependency ghost rows inline, flags violations, supports reordering, write mode, and project jump', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const stateUpdates: Array<{ id: string; stateId: string }> = [];

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
        variables?: { id?: string; stateId?: string; teamId?: string };
      } | null;
      const query = payload?.query ?? '';
      if (await defaultScheduleMock.handle(route, payload)) return;

      if (query.includes('projects(')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              projects: {
                nodes: [
                  { id: 'proj-1', name: 'Commissioning' },
                  { id: 'proj-2', name: 'Controls' },
                ],
              },
            },
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
        const pid = payload?.variables?.id;
        if (pid === 'proj-2') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              data: {
                project: {
                  name: 'Controls',
                  startDate: isoOffsetDays(-5),
                  targetDate: isoOffsetDays(20),
                  projectMilestones: { nodes: [] },
                  issues: {
                    nodes: [
                      {
                        id: 'uuid-ctrl-42',
                        identifier: 'CTRL-42',
                        title: 'Wire PLC cabinet',
                        description: `${startTagOffsetDays(-3)}\nPLC cabinet wiring`,
                        dueDate: isoOffsetDays(6),
                        url: 'https://linear.app/bluecoreenergy/issue/CTRL-42',
                        priority: 1,
                        state: { name: 'In Progress', type: 'started' },
                        createdAt: '2026-01-01T00:00:00Z',
                        completedAt: null,
                        assignee: { name: 'Carol Vance' },
                        team: { id: 'team-ctrl' },
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

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              project: {
                name: 'Commissioning',
                startDate: isoOffsetDays(-5),
                targetDate: isoOffsetDays(20),
                projectMilestones: { nodes: [] },
                issues: {
                  nodes: [
                    {
                      id: 'uuid-comm-1',
                      identifier: 'COMM-101',
                      title: 'Run commissioning loop check',
                      description: `${startTagOffsetDays(2)}\nLoop check details`,
                      dueDate: isoOffsetDays(10),
                      url: 'https://linear.app/bluecoreenergy/issue/COMM-101',
                      priority: 2,
                      state: { name: 'Todo', type: 'unstarted' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Andrew Phillips' },
                      team: { id: 'team-comm' },
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
                    id: 'uuid-comm-1',
                    identifier: 'COMM-101',
                    relations: {
                      nodes: [
                        {
                          type: 'blocked_by',
                          relatedIssue: {
                            id: 'uuid-ctrl-42',
                            identifier: 'CTRL-42',
                            title: 'Wire PLC cabinet',
                            description: `${startTagOffsetDays(-3)}\nPLC cabinet wiring`,
                            dueDate: isoOffsetDays(6),
                            url: 'https://linear.app/bluecoreenergy/issue/CTRL-42',
                            priority: 1,
                            completedAt: null,
                            canceledAt: null,
                            state: { name: 'In Progress', type: 'started' },
                            assignee: { name: 'Carol Vance' },
                            team: { id: 'team-ctrl' },
                            project: { id: 'proj-2', name: 'Controls', targetDate: isoOffsetDays(20) },
                          },
                        },
                      ],
                    },
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
        const teamId = payload?.variables?.teamId;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              workflowStates: {
                nodes:
                  teamId === 'team-ctrl'
                    ? [
                        { id: 'ctrl-todo', name: 'Todo', type: 'unstarted', position: 0 },
                        { id: 'ctrl-prog', name: 'In Progress', type: 'started', position: 1 },
                        { id: 'ctrl-done', name: 'Done', type: 'completed', position: 2 },
                      ]
                    : [
                        { id: 'comm-todo', name: 'Todo', type: 'unstarted', position: 0 },
                        { id: 'comm-done', name: 'Done', type: 'completed', position: 1 },
                      ],
              },
            },
          }),
        });
        return;
      }

      if (query.includes('issueUpdate')) {
        stateUpdates.push({
          id: String(payload?.variables?.id ?? ''),
          stateId: String(payload?.variables?.stateId ?? ''),
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { issueUpdate: { success: true } } }),
        });
        return;
      }

      if (query.includes('viewer')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { viewer: { id: 'usr-1', name: 'Demo User' } } }),
        });
        return;
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');

    // 1. Ghost row CTRL-42 renders inline above blocked task COMM-101 with cross-project badge and SVG arrow
    const rows = page.locator('#gantt-export-target tbody tr[data-task-id]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-task-id', 'CTRL-42');
    await expect(rows.nth(0)).toHaveAttribute('data-external-task', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-task-id', 'COMM-101');

    // StatsRow count stays scoped to current project's local tasks (1 Active)
    await expect(
      page
        .locator('div')
        .filter({ hasText: /^1Active$/ })
        .first(),
    ).toBeVisible();

    // Cross-project SVG arrow connects CTRL-42 -> COMM-101 (flagged as violated because COMM-101 starts +2d <= CTRL-42 due +6d)
    const crossArrow = page.locator('svg path[data-arrow-source="CTRL-42"][data-arrow-target="COMM-101"]');
    await expect(crossArrow).toHaveCount(1);
    await expect(crossArrow).toHaveAttribute('data-cross-project', 'true');
    // Violated cross-project arrows keep their own color and marker, and route with rounded elbows
    await expect(crossArrow).toHaveAttribute('stroke', '#f97316');
    await expect(crossArrow).toHaveAttribute('marker-end', 'url(#dep-arrow-warn)');
    await expect(crossArrow).toHaveAttribute('d', /^M[-\d\s.HVQA,]+$/);

    // 2. Ghost row is read-only by default (status bubble is a static span, not a button)
    await expect(page.locator('button[data-status-bubble="CTRL-42"]')).toHaveCount(0);
    await expect(page.locator('span[data-status-bubble="CTRL-42"]')).toBeVisible();
    // ...and so are its status, assignee, and title cells: no dropdown triggers, no inline rename
    await expect(page.locator('[data-status-cell="CTRL-42"]')).toHaveCount(0);
    await expect(page.locator('[data-assignee-cell="CTRL-42"]')).toHaveCount(0);
    await page.locator('[data-task-title="CTRL-42"]').dblclick();
    await expect(page.locator('input[data-inline-edit="title"]')).toHaveCount(0);
    // A local row in the same table stays editable
    await expect(page.locator('[data-status-cell="COMM-101"]')).toBeVisible();

    // 3. Ghost row can be moved up and down like a normal row (Alt+ArrowDown)
    await rows.nth(0).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(rows.nth(0)).toHaveAttribute('data-task-id', 'COMM-101');
    await expect(rows.nth(1)).toHaveAttribute('data-task-id', 'CTRL-42');

    // 4. Activating write mode ("Edit external") makes CTRL-42 directly editable inline
    const editExternalBtn = page.getByRole('button', { name: 'Edit external' });
    await editExternalBtn.click();
    await expect(page.getByRole('button', { name: 'Editing external' })).toHaveAttribute('aria-pressed', 'true');

    await expect(page.locator('[data-status-cell="CTRL-42"]')).toBeVisible();
    await expect(page.locator('[data-assignee-cell="CTRL-42"]')).toBeVisible();
    const ctrlBubbleBtn = page.locator('button[data-status-bubble="CTRL-42"]');
    await expect(ctrlBubbleBtn).toBeVisible();
    await ctrlBubbleBtn.click();
    const ctrlMenu = page.locator('[data-inline-menu="Status for CTRL-42"]');
    await expect(ctrlMenu).toBeVisible();
    await ctrlMenu.getByRole('option', { name: 'Done' }).click();
    await expect(page.getByText('Status → Done')).toBeVisible();
    expect(stateUpdates).toEqual([{ id: 'uuid-ctrl-42', stateId: 'ctrl-done' }]);

    // Regression: dragging an external bar while unlocked and then locking must still allow opening DetailPanel on click
    const ctrlBar = page.locator('[data-task-bar="CTRL-42"]');
    const ctrlBarBox = await ctrlBar.boundingBox();
    expect(ctrlBarBox).not.toBeNull();
    await page.mouse.move(ctrlBarBox!.x + ctrlBarBox!.width / 2, ctrlBarBox!.y + ctrlBarBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(ctrlBarBox!.x + ctrlBarBox!.width / 2 + 12, ctrlBarBox!.y - 30);
    await page.mouse.up();
    await page.getByRole('button', { name: 'Editing external' }).click();
    await expect(page.getByRole('button', { name: 'Edit external' })).toBeVisible();
    await ctrlBar.click();
    await expect(page.getByText('PLC cabinet wiring')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('PLC cabinet wiring')).toHaveCount(0);

    // 5. Cross-project toggle hides and restores external ghost rows
    const crossProjectToggle = page.getByRole('button', { name: /Cross-project/ });
    await crossProjectToggle.click();
    await expect(page.locator('tr[data-task-id="CTRL-42"]')).toHaveCount(0);
    await crossProjectToggle.click();
    await expect(page.locator('tr[data-task-id="CTRL-42"]')).toBeVisible();

    // 6. Clicking the external project badge jumps directly to Controls (proj-2)
    await page.locator('[data-external-project-jump="proj-2"]').click();
    await expect(page).toHaveURL(/\/app\?project=proj-2$/);
    await expect(page.locator('tr[data-task-id="CTRL-42"]')).toBeVisible();
    await expect(page.locator('tr[data-task-id="CTRL-42"]')).not.toHaveAttribute('data-external-task', 'true');

    expect(errors).toEqual([]);
  });

  test('groups sub-issues under their parent row and indents them by depth', async ({ page }) => {
    const errors = trackErrors(page);
    await mockSubtaskProject(page);
    await page.goto('/app');

    // The API sorts ENG-201 ahead of its parent; grouping pulls children (and the grandchild) under ENG-200
    const rows = page.locator('tr[data-task-id]');
    await expect(rows).toHaveCount(6);
    const order = () => rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.taskId));
    await expect.poll(order).toEqual(['ENG-220', 'ENG-200', 'ENG-201', 'ENG-203', 'ENG-202', 'ENG-210']);
    await expect(page.locator('tr[data-task-id="ENG-200"]')).toHaveAttribute('data-task-depth', '0');
    await expect(page.locator('tr[data-task-id="ENG-201"]')).toHaveAttribute('data-task-depth', '1');
    await expect(page.locator('tr[data-task-id="ENG-203"]')).toHaveAttribute('data-task-depth', '2');
    await expect(page.locator('tr[data-task-id="ENG-202"]')).toHaveAttribute('data-task-depth', '1');
    await expect(page.locator('tr[data-task-id="ENG-210"]')).toHaveAttribute('data-task-depth', '0');

    // Each level is indented further to the right in the task column
    // Measured on the tree gutter, the first thing rendered inside the indented container
    const idX = async (id: string) =>
      (await page
        .locator(`tr[data-task-id="${id}"] td[data-column-key="task"] [data-task-indent] > :first-child`)
        .boundingBox())!.x;
    const [x200, x201, x203, x202, x210] = [
      await idX('ENG-200'),
      await idX('ENG-201'),
      await idX('ENG-203'),
      await idX('ENG-202'),
      await idX('ENG-210'),
    ];
    expect(x201).toBeGreaterThanOrEqual(x200 + 17);
    expect(x203).toBeGreaterThanOrEqual(x201 + 17);
    expect(x202).toBeCloseTo(x201, 0);
    expect(x210).toBeCloseTo(x200, 0);

    // Only rows that have sub-issues get a chevron, and parents start expanded
    await expect(page.locator('[data-collapse-toggle]')).toHaveCount(2);
    await expect(page.locator('[data-collapse-toggle="ENG-200"]')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-collapse-toggle="ENG-201"]')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-collapse-toggle="ENG-200"]')).toHaveAccessibleName(
      'Collapse 2 sub-issues of ENG-200',
    );

    expect(errors).toEqual([]);
  });

  test('collapses and expands a parent, keeps the choice across reloads, and never opens the detail panel', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await mockSubtaskProject(page);
    await page.goto('/app');

    const toggle = page.locator('[data-collapse-toggle="ENG-200"]');
    await expect(page.locator('[data-task-bar="ENG-202"]')).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAccessibleName('Expand 2 sub-issues of ENG-200');
    await expect(toggle).toHaveAttribute('title', 'Expand 2 sub-issues');
    // The whole subtree goes, including the grandchild, and its nested chevron with it
    for (const id of ['ENG-201', 'ENG-202', 'ENG-203']) {
      await expect(page.locator(`tr[data-task-id="${id}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-task-bar="${id}"]`)).toHaveCount(0);
    }
    await expect(page.locator('tr[data-task-id="ENG-200"]')).toBeVisible();
    await expect(page.locator('tr[data-task-id]')).toHaveCount(3);
    // Clicking the chevron neither opens the detail panel nor starts anything else
    await expect(page.getByText('Valve program details')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('gantt_collapsed_parents'))).toBe('["ENG-200"]');

    // Persists across a reload
    await page.reload();
    await expect(page.locator('tr[data-task-id="ENG-200"]')).toBeVisible();
    await expect(page.locator('tr[data-task-id]')).toHaveCount(3);
    await expect(page.locator('[data-collapse-toggle="ENG-200"]')).toHaveAttribute('aria-expanded', 'false');

    // Expanding restores the subtree, with the nested parent still expanded
    await page.locator('[data-collapse-toggle="ENG-200"]').click();
    await expect(page.locator('tr[data-task-id]')).toHaveCount(6);
    await expect(page.locator('[data-task-bar="ENG-203"]')).toBeVisible();
    await expect(page.locator('[data-collapse-toggle="ENG-201"]')).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => localStorage.getItem('gantt_collapsed_parents'))).toBe('[]');

    // A nested parent collapses on its own and leaves its siblings alone
    await page.locator('[data-collapse-toggle="ENG-201"]').click();
    await expect(page.locator('tr[data-task-id="ENG-203"]')).toHaveCount(0);
    await expect(page.locator('tr[data-task-id="ENG-201"]')).toBeVisible();
    await expect(page.locator('tr[data-task-id="ENG-202"]')).toBeVisible();

    // Opening a bar still works and the keyboard can operate the chevron
    await page.locator('[data-task-bar="ENG-200"]').click();
    await expect(page.getByText('Valve program details')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Valve program details')).toHaveCount(0);
    await page.locator('[data-collapse-toggle="ENG-201"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('tr[data-task-id="ENG-203"]')).toBeVisible();
    await expect(page.getByText('Valve program details')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('collapses and expands the summary row, and keeps the choice across reloads', async ({ page }) => {
    const errors = trackErrors(page);
    await mockSubtaskProject(page);
    await page.goto('/app');

    const hide = page.getByRole('button', { name: 'Hide summary' });
    const show = page.getByRole('button', { name: 'Show summary' });
    const bar = page.locator('[data-task-bar="ENG-200"]');
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Total Span', { exact: true })).toBeVisible();
    const expandedY = (await bar.boundingBox())!.y;

    await hide.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Total Span', { exact: true })).toHaveCount(0);
    await expect(show).toBeVisible();
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    // Focus follows the toggle to the button that replaced it
    await expect(show).toBeFocused();
    expect((await bar.boundingBox())!.y).toBeLessThan(expandedY);
    expect(await page.evaluate(() => localStorage.getItem('gantt_summary_collapsed'))).toBe('1');

    await page.reload();
    await expect(page.locator('[data-task-bar="ENG-200"]')).toBeVisible();
    await expect(show).toBeVisible();
    await expect(page.getByText('Total Span', { exact: true })).toHaveCount(0);

    // After a reload nothing is focused, so start the keyboard flow from the control
    await show.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Total Span', { exact: true })).toBeVisible();
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    await expect(hide).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('gantt_summary_collapsed'))).toBe('0');

    // Focus is already on the new control, so Enter again toggles back with no refocus
    await page.keyboard.press('Enter');
    await expect(show).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('gantt_summary_collapsed'))).toBe('1');

    await show.click();
    await expect(page.getByText('Total Span', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Total Span', { exact: true })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('rolls dependency arrows up to a collapsed parent bar', async ({ page }) => {
    const errors = trackErrors(page);
    await mockSubtaskProject(page);
    await page.goto('/app');

    const arrow = (from: string, to: string) =>
      page.locator(`svg path[data-arrow-source="${from}"][data-arrow-target="${to}"]`);
    const allArrows = page.locator('svg path[data-arrow-source]');

    // Expanded: each relation is drawn between the real bars
    await expect(arrow('ENG-201', 'ENG-210')).toHaveCount(1);
    await expect(arrow('ENG-202', 'ENG-210')).toHaveCount(1);
    await expect(arrow('ENG-201', 'ENG-202')).toHaveCount(1);
    await expect(allArrows).toHaveCount(3);

    // Collapsed: both children's arrows roll up into one ENG-200 -> ENG-210 arrow, and the
    // sibling-to-sibling relation vanishes because it now sits inside one bar
    await page.locator('[data-collapse-toggle="ENG-200"]').click();
    await expect(arrow('ENG-200', 'ENG-210')).toHaveCount(1);
    await expect(allArrows).toHaveCount(1);
    await expect(arrow('ENG-201', 'ENG-210')).toHaveCount(0);

    // The rolled-up arrow leaves the parent bar's right edge and enters the target bar's left edge
    const chartBox = (await page.getByTestId('gantt-chart-body').boundingBox())!;
    const parentBox = (await page.locator('[data-task-bar="ENG-200"]').boundingBox())!;
    const targetBox = (await page.locator('[data-task-bar="ENG-210"]').boundingBox())!;
    // Paths are `M x y` then H/V segments, so the last two numbers are the final vertical and the target x
    const coords = (await arrow('ENG-200', 'ENG-210').getAttribute('d'))!.match(/-?[\d.]+/g)!.map(Number);
    const [startX, startY] = coords;
    const endX = coords[coords.length - 1];
    const endY = coords.length > 3 ? coords[coords.length - 2] : startY;
    expect(startX).toBeCloseTo(parentBox.x + parentBox.width - chartBox.x, 0);
    expect(startY).toBeCloseTo(parentBox.y + parentBox.height / 2 - chartBox.y, 0);
    expect(endX).toBeCloseTo(targetBox.x - chartBox.x, 0);
    expect(endY).toBeCloseTo(targetBox.y + targetBox.height / 2 - chartBox.y, 0);

    // Expanding restores the individual arrows
    await page.locator('[data-collapse-toggle="ENG-200"]').click();
    await expect(arrow('ENG-201', 'ENG-210')).toHaveCount(1);
    await expect(arrow('ENG-200', 'ENG-210')).toHaveCount(0);
    await expect(allArrows).toHaveCount(3);

    // Collapsing only the nested parent rolls just its own relations up
    await page.locator('[data-collapse-toggle="ENG-201"]').click();
    await expect(arrow('ENG-201', 'ENG-210')).toHaveCount(1);
    await expect(arrow('ENG-201', 'ENG-202')).toHaveCount(1);

    expect(errors).toEqual([]);
  });

  test('reveals matching sub-issues under collapsed parents while search or filters are active', async ({ page }) => {
    const errors = trackErrors(page);
    await mockSubtaskProject(page);
    await page.goto('/app');

    await page.locator('[data-collapse-toggle="ENG-200"]').click();
    await expect(page.locator('tr[data-task-id]')).toHaveCount(3);

    // A search that matches only sub-issues surfaces them even though their parent is collapsed
    const search = page.getByPlaceholder('Search tasks…');
    await search.fill('needle');
    await expect(page.locator('tr[data-task-id]')).toHaveCount(2);
    await expect(page.locator('[data-task-bar="ENG-202"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-203"]')).toBeVisible();
    // Their parents are filtered out, so they read as top-level rows instead of dangling under nothing
    await expect(page.locator('tr[data-task-id="ENG-202"]')).toHaveAttribute('data-task-depth', '0');
    await expect(page.locator('tr[data-task-id="ENG-203"]')).toHaveAttribute('data-task-depth', '0');
    await expect(page.locator('tr[data-task-id="ENG-200"]')).toHaveCount(0);

    // When parent and sub-issues all match, the collapsed parent is forced open and its chevron is inert
    await search.fill('valve');
    const parentToggle = page.locator('[data-collapse-toggle="ENG-200"]');
    await expect(page.locator('tr[data-task-id]')).toHaveCount(3);
    await expect(page.locator('[data-task-bar="ENG-201"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-202"]')).toBeVisible();
    await expect(page.locator('tr[data-task-id="ENG-201"]')).toHaveAttribute('data-task-depth', '1');
    await expect(parentToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(parentToggle).toBeDisabled();

    // The remembered collapse comes back as soon as the search is cleared
    await search.fill('');
    await expect(page.locator('tr[data-task-id]')).toHaveCount(3);
    await expect(page.locator('tr[data-task-id="ENG-201"]')).toHaveCount(0);
    await expect(parentToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(parentToggle).toBeEnabled();

    // Assignee filters count as filters too: Nate's sub-issues show up under the collapsed parent
    await page.getByTestId('column-filter-assignee').click();
    await page.getByRole('option', { name: /Nate Jones/ }).click();
    await expect(page.locator('[data-task-bar="ENG-202"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-203"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-210"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-200"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('keeps hierarchy intact when reordering rows with the keyboard', async ({ page }) => {
    const errors = trackErrors(page);
    await mockSubtaskProject(page);
    await page.goto('/app');

    const rows = page.locator('tr[data-task-id]');
    const order = () => rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.taskId));
    await expect.poll(order).toEqual(['ENG-220', 'ENG-200', 'ENG-201', 'ENG-203', 'ENG-202', 'ENG-210']);

    // A parent moves as a block with its whole subtree, stepping over its own sub-issues
    await page.locator('tr[data-task-id="ENG-200"]').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(order).toEqual(['ENG-220', 'ENG-210', 'ENG-200', 'ENG-201', 'ENG-203', 'ENG-202']);

    // A sub-issue swaps with its sibling and takes its own sub-issues along
    await page.locator('tr[data-task-id="ENG-201"]').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(order).toEqual(['ENG-220', 'ENG-210', 'ENG-200', 'ENG-202', 'ENG-201', 'ENG-203']);

    // A sub-issue can't leave its parent: nothing moves and a toast explains why
    await page.locator('tr[data-task-id="ENG-202"]').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByText('Sub-issues can only be reordered within their parent')).toBeVisible();
    await expect.poll(order).toEqual(['ENG-220', 'ENG-210', 'ENG-200', 'ENG-202', 'ENG-201', 'ENG-203']);

    // The custom order survives a reload and is still grouped
    await page.reload();
    await expect(rows).toHaveCount(6);
    await expect.poll(order).toEqual(['ENG-220', 'ENG-210', 'ENG-200', 'ENG-202', 'ENG-201', 'ENG-203']);

    expect(errors).toEqual([]);
  });
});
