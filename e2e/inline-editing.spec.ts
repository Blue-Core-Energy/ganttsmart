import { expect, test } from '@playwright/test';
import {
  blockFonts,
  createScheduleMock,
  isoOffsetDays,
  localOffsetDate,
  startTagOffsetDays,
  trackErrors,
} from './helpers/index.js';

let defaultScheduleMock = createScheduleMock();

test.describe('GanttSmart GCP app', () => {
  test.beforeEach(async ({ page }) => {
    defaultScheduleMock = createScheduleMock();
    await blockFonts(page);
  });

  test('opens status dropdown when clicking or activating status bubble or pressing s without opening DetailPanel', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const stateUpdates: Array<{ id: string; stateId: string }> = [];
    let failNextUpdate = false;

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
                startDate: isoOffsetDays(-5),
                targetDate: isoOffsetDays(15),
                projectMilestones: { nodes: [] },
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
                      projectMilestone: null,
                    },
                    {
                      id: 'uuid-2',
                      identifier: 'ENG-102',
                      title: 'Verify telemetry',
                      description: `${startTagOffsetDays(0)}\nTelemetry details`,
                      dueDate: isoOffsetDays(7),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-102',
                      priority: 3,
                      state: { name: 'Todo', type: 'unstarted' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Nate Jones' },
                      team: { id: 'team-2' },
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
        const teamId = payload?.variables?.teamId;
        expect(query).toContain('$teamId: ID!');
        if (teamId === 'team-2') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              data: {
                workflowStates: {
                  nodes: [
                    { id: 'st2-todo', name: 'Todo', type: 'unstarted', position: 0 },
                    { id: 'st2-prog', name: 'Working', type: 'started', position: 0 },
                    { id: 'st2-done', name: 'Shipped', type: 'completed', position: 0 },
                  ],
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
              workflowStates: {
                nodes: [
                  { id: 'st-dup', name: 'Duplicate', type: 'duplicate', position: 0 },
                  { id: 'st-done', name: 'Done', type: 'completed', position: 0 },
                  { id: 'st-can', name: 'Canceled', type: 'canceled', position: 0 },
                  { id: 'st-prog', name: 'In Progress', type: 'started', position: 0 },
                  { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 },
                  { id: 'st-back', name: 'Backlog', type: 'backlog', position: 0 },
                ],
              },
            },
          }),
        });
        return;
      }

      if (query.includes('issueUpdate')) {
        if (failNextUpdate) {
          failNextUpdate = false;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ errors: [{ message: 'Permission denied' }] }),
          });
          return;
        }
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

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');
    const row101 = page.locator('tr[data-task-id="ENG-101"]');
    const bubble101 = page.locator('[data-status-bubble="ENG-101"]');
    const bar101 = page.locator('[data-task-bar="ENG-101"]');
    const menu101 = page.locator('[data-inline-menu="Status for ENG-101"]');

    await expect(bubble101).toBeVisible();
    await expect(bubble101).toHaveAttribute('title', 'In Progress — click to change');

    // 1. Click status bubble: opens status dropdown without opening DetailPanel
    await bubble101.click();
    await expect(menu101).toBeVisible();
    await expect(page.getByText('Manifold details')).toHaveCount(0);
    await menu101.getByRole('option', { name: 'Done' }).click();
    await expect(menu101).toHaveCount(0);
    await expect(bubble101).toHaveAttribute('title', 'Done — click to change');
    await expect(row101).toHaveAttribute('data-task-done', 'true');
    await expect(bar101).toHaveClass(/\bbar-done\b/);
    await expect(bar101).toContainText('✓ Done');
    await expect(page.getByText('Status → Done')).toBeVisible();
    await expect(page.getByText('Manifold details')).toHaveCount(0);
    expect(stateUpdates[0]).toEqual({ id: 'uuid-1', stateId: 'st-done' });

    // 2. Keyboard activation on status bubble (Space and Enter) opens menu without opening DetailPanel
    await bubble101.focus();
    await page.keyboard.press('Space');
    await expect(menu101).toBeVisible();
    await expect(page.getByText('Manifold details')).toHaveCount(0);
    // Escape returns focus to the bubble
    await page.keyboard.press('Escape');
    await expect(menu101).toHaveCount(0);
    await expect(bubble101).toBeFocused();

    // Enter also opens the menu
    await page.keyboard.press('Enter');
    await expect(menu101).toBeVisible();
    await expect(page.getByText('Manifold details')).toHaveCount(0);
    await menu101.getByRole('option', { name: 'Todo' }).click();
    await expect(menu101).toHaveCount(0);
    await expect(bubble101).toHaveAttribute('title', 'Todo — click to change');
    await expect(bubble101).toBeFocused();
    expect(stateUpdates[1]).toEqual({ id: 'uuid-1', stateId: 'st-todo' });

    // 3. Pressing 's' on a focused row opens status dropdown without opening DetailPanel
    await row101.focus();
    await page.keyboard.press('s');
    await expect(menu101).toBeVisible();
    await expect(page.getByText('Manifold details')).toHaveCount(0);
    await menu101.getByRole('option', { name: 'In Progress' }).click();
    await expect(menu101).toHaveCount(0);
    await expect(bubble101).toHaveAttribute('title', 'In Progress — click to change');
    expect(stateUpdates[2]).toEqual({ id: 'uuid-1', stateId: 'st-prog' });

    // 4. Second team (team-2) uses its own workflow states
    const bubble102 = page.locator('[data-status-bubble="ENG-102"]');
    const menu102 = page.locator('[data-inline-menu="Status for ENG-102"]');
    await expect(bubble102).toHaveAttribute('title', 'Todo — click to change');
    await bubble102.click();
    await expect(menu102).toBeVisible();
    await expect(menu102.getByRole('option')).toContainText(['Todo', 'Working', 'Shipped']);
    await menu102.getByRole('option', { name: 'Working' }).click();
    await expect(menu102).toHaveCount(0);
    await expect(bubble102).toHaveAttribute('title', 'Working — click to change');
    expect(stateUpdates[3]).toEqual({ id: 'uuid-2', stateId: 'st2-prog' });

    // 5. Failed mutation rolls back status cleanly and displays an error toast
    failNextUpdate = true;
    await bubble102.click();
    await expect(menu102).toBeVisible();
    await menu102.getByRole('option', { name: 'Shipped' }).click();
    await expect(page.getByText('Failed to update status: Permission denied')).toBeVisible();
    await expect(bubble102).toHaveAttribute('title', 'Working — click to change');

    // 6. Narrow screen at 375px: status bubble in Issue column opens menu within viewport
    await page.setViewportSize({ width: 375, height: 812 });
    const mobileBubble101 = page.locator('td[data-column-key="task"] [data-status-bubble="ENG-101"]');
    await expect(mobileBubble101).toBeVisible();
    await mobileBubble101.click();
    await expect(menu101).toBeVisible();
    await expect(page.getByText('Manifold details')).toHaveCount(0);
    const menuBox = (await menu101.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(375);
    await menu101.getByRole('option', { name: 'Done' }).click();
    await expect(menu101).toHaveCount(0);
    await expect(mobileBubble101).toHaveAttribute('title', 'Done — click to change');
    expect(stateUpdates[4]).toEqual({ id: 'uuid-1', stateId: 'st-done' });

    // Pressing 's' on mobile row also opens menu anchored within viewport; Escape restores focus to the row
    const mobileRow101 = page.locator('tr[data-task-id="ENG-101"]');
    await mobileRow101.focus();
    await page.keyboard.press('s');
    await expect(menu101).toBeVisible();
    const sMenuBox = (await menu101.boundingBox())!;
    expect(sMenuBox.x).toBeGreaterThanOrEqual(0);
    expect(sMenuBox.x + sMenuBox.width).toBeLessThanOrEqual(375);
    await page.keyboard.press('Escape');
    await expect(menu101).toHaveCount(0);
    await expect(mobileRow101).toBeFocused();

    expect(errors).toEqual([]);
  });

  test('edits status, assignee, and title inline from schedule table cells', async ({ page }) => {
    const errors = trackErrors(page);
    const updates: Array<Record<string, unknown>> = [];
    let projectLoads = 0;
    let failNextUpdate = false;

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
        variables?: Record<string, unknown>;
      } | null;
      if (await defaultScheduleMock.handle(route, payload)) return;
      const query = payload?.query ?? '';
      const respond = (data: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });

      if (query.includes('projects(')) {
        await respond({ projects: { nodes: [{ id: 'proj-1', name: 'Demo Project' }] } });
        return;
      }

      if (query.includes('project(id:')) {
        projectLoads++;
        await respond({
          project: {
            name: 'Demo Project',
            startDate: isoOffsetDays(-10),
            targetDate: isoOffsetDays(20),
            projectMilestones: { nodes: [] },
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
                  assignee: { id: 'user-andrew', name: 'Andrew Phillips' },
                  team: { id: 'team-1' },
                  projectMilestone: null,
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
                  assignee: { id: 'user-nate', name: 'Nate Jones' },
                  team: { id: 'team-1' },
                  projectMilestone: null,
                },
              ],
            },
            doneIssues: { nodes: [] },
          },
        });
        return;
      }

      if (query.includes('members(')) {
        expect(payload?.variables?.teamId).toBe('team-1');
        await respond({
          team: {
            members: {
              nodes: [
                { id: 'user-priya', name: 'Priya Shah', displayName: 'priya', active: true },
                { id: 'user-nate', name: 'Nate Jones', displayName: 'nate', active: true },
                { id: 'user-gone', name: 'Dana Departed', displayName: 'dana', active: false },
                { id: 'user-andrew', name: 'Andrew Phillips', displayName: 'andrew', active: true },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
        return;
      }

      if (query.includes('relations')) {
        await respond({ issues: { nodes: [] } });
        return;
      }

      if (query.includes('workflowStates')) {
        await respond({
          workflowStates: {
            nodes: [
              { id: 'st-dup', name: 'Duplicate', type: 'duplicate', position: 0 },
              { id: 'st-done', name: 'Done', type: 'completed', position: 0 },
              { id: 'st-can', name: 'Canceled', type: 'canceled', position: 0 },
              { id: 'st-prog', name: 'In Progress', type: 'started', position: 0 },
              { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 },
              { id: 'st-back', name: 'Backlog', type: 'backlog', position: 0 },
            ],
          },
        });
        return;
      }

      if (query.includes('issueUpdate')) {
        if (failNextUpdate) {
          failNextUpdate = false;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ errors: [{ message: 'Permission denied' }] }),
          });
          return;
        }
        updates.push(payload?.variables ?? {});
        await respond({ issueUpdate: { success: true } });
        return;
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');
    const row101 = page.locator('tr[data-task-id="ENG-101"]');
    const row102 = page.locator('tr[data-task-id="ENG-102"]');
    const menu = page.locator('[data-inline-menu]');
    const titleInput = page.locator('input[data-inline-edit="title"]');
    await expect(row101).toBeVisible();

    // ---- Status dropdown ----
    await row101.getByRole('button', { name: 'Change status, currently In Progress' }).click();
    await expect(menu).toBeVisible();
    // Portaled to <body> so the table's overflow never clips it
    expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true);
    await expect(menu.getByRole('option')).toHaveText([
      'Backlog',
      'Todo',
      'In Progress',
      'Done',
      'Canceled',
      'Duplicate',
    ]);
    await expect(menu.getByRole('option', { name: 'In Progress' })).toHaveAttribute('aria-selected', 'true');
    await expect(menu.getByRole('option', { name: 'Todo' })).toHaveAttribute('aria-selected', 'false');
    // Opening the menu neither opens DetailPanel nor starts a row drag
    await expect(page.getByText('Manifold details')).toHaveCount(0);

    await menu.getByRole('option', { name: 'Done' }).click();
    await expect(menu).toHaveCount(0);
    await expect(row101).toHaveAttribute('data-task-done', 'true');
    await expect(page.locator('[data-status-bubble="ENG-101"]')).toHaveAttribute('title', 'Done — click to change');
    await expect(page.getByText('Status → Done')).toBeVisible();
    expect(updates).toEqual([{ id: 'uuid-1', stateId: 'st-done' }]);

    // Clicking the empty part of the cell opens the menu too; Escape closes it without side effects
    const statusCell = page.locator('[data-status-cell="ENG-101"]');
    const statusBox = (await statusCell.boundingBox())!;
    await statusCell.click({ position: { x: statusBox.width - 6, y: 6 } });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('option', { name: 'Done' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(updates).toHaveLength(1);

    // Keyboard: arrows + Enter pick a state, and the row never sees those keys
    await row101.getByRole('button', { name: 'Change status, currently Done' }).click();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('[data-status-bubble="ENG-101"]')).toHaveAttribute(
      'title',
      'In Progress — click to change',
    );
    expect(updates[1]).toEqual({ id: 'uuid-1', stateId: 'st-prog' });

    // The status bubble opens the menu too
    await page.locator('[data-status-bubble="ENG-102"]').click();
    const menu102 = page.locator('[data-inline-menu="Status for ENG-102"]');
    await expect(menu102).toBeVisible();
    await menu102.getByRole('option', { name: 'In Progress' }).click();
    await expect(menu102).toHaveCount(0);
    await expect(page.locator('[data-status-bubble="ENG-102"]')).toHaveAttribute(
      'title',
      'In Progress — click to change',
    );
    expect(updates[2]).toEqual({ id: 'uuid-2', stateId: 'st-prog' });

    // Failed mutation rolls the status back and shows an error toast
    failNextUpdate = true;
    await row102.getByRole('button', { name: 'Change status, currently In Progress' }).click();
    await menu.getByRole('option', { name: 'Backlog' }).click();
    await expect(page.getByText('Failed to update status: Permission denied')).toBeVisible();
    await expect(page.locator('[data-status-bubble="ENG-102"]')).toHaveAttribute(
      'title',
      'In Progress — click to change',
    );

    // ---- Assignee dropdown ----
    const loadsBeforeSearch = projectLoads;
    await row102.getByRole('button', { name: 'Change assignee, currently Nate Jones' }).click();
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true);
    const search = menu.getByRole('combobox', { name: 'Search people…' });
    await expect(search).toBeFocused();
    await expect(menu.getByRole('option')).toContainText(['Unassigned', 'Andrew Phillips', 'Nate Jones', 'Priya Shah']);
    await expect(menu.getByRole('option', { name: 'Nate Jones' })).toHaveAttribute('aria-selected', 'true');

    // Typing shortcuts ('r' refreshes, 's' opens status menu) must stay inside the search box
    await search.fill('pr');
    await expect(menu.getByRole('option')).toContainText(['Priya Shah']);
    await expect(menu.getByRole('option')).toHaveCount(1);
    await page.keyboard.type('s');
    await expect(search).toHaveValue('prs');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ArrowDown');
    await expect(search).toBeFocused();
    await expect(page.locator('tr[data-task-id="ENG-102"]')).not.toBeFocused();
    expect(projectLoads).toBe(loadsBeforeSearch);
    await expect(page.locator('[data-status-bubble="ENG-102"]')).toHaveAttribute(
      'title',
      'In Progress — click to change',
    );

    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    await expect(row102.locator('[data-assignee-cell="ENG-102"]')).toContainText('Priya Shah');
    await expect(page.getByText('Assigned to Priya Shah')).toBeVisible();
    expect(updates[3]).toEqual({ id: 'uuid-2', assigneeId: 'user-priya' });

    // "Unassigned" clears the assignee (sends null)
    await row102.getByRole('button', { name: 'Change assignee, currently Priya Shah' }).click();
    await menu.getByRole('option', { name: 'Unassigned' }).click();
    await expect(row102.locator('[data-assignee-cell="ENG-102"]')).toContainText('Unassigned');
    await expect(page.getByText('Unassigned', { exact: true }).first()).toBeVisible();
    expect(updates[4]).toEqual({ id: 'uuid-2', assigneeId: null });

    // Escape closes without changing anything; failures roll back
    await row102.getByRole('button', { name: 'Change assignee, currently Unassigned' }).click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    expect(updates).toHaveLength(5);

    failNextUpdate = true;
    await row102.getByRole('button', { name: 'Change assignee, currently Unassigned' }).click();
    await menu.getByRole('option', { name: 'Andrew Phillips' }).click();
    await expect(page.getByText('Failed to update assignee: Permission denied')).toBeVisible();
    await expect(row102.locator('[data-assignee-cell="ENG-102"]')).toContainText('Unassigned');

    // Clicking outside closes an open menu
    await row101.getByRole('button', { name: 'Change assignee, currently Andrew Phillips' }).click();
    await expect(menu).toBeVisible();
    await page.mouse.click(5, 300);
    await expect(menu).toHaveCount(0);

    // Opening another row's menu swaps the open menu instead of leaving two floating. A menu opens below
    // its row, so the row above stays clickable while the menu is open.
    const statusButton = (id: string) => page.locator(`[data-status-cell="${id}"] button[aria-haspopup="listbox"]`);
    await statusButton('ENG-102').click();
    await expect(menu).toHaveAttribute('data-inline-menu', 'Status for ENG-102');
    await statusButton('ENG-101').click();
    await expect(menu).toHaveCount(1);
    await expect(menu).toHaveAttribute('data-inline-menu', 'Status for ENG-101');
    await row101.locator('[data-assignee-cell="ENG-101"] button[aria-haspopup="listbox"]').click();
    await expect(menu).toHaveCount(1);
    await expect(menu).toHaveAttribute('data-inline-menu', 'Assignee for ENG-101');

    // Controls that stop propagation (task bar, status bubble) still dismiss an open menu
    await page.locator('[data-task-bar="ENG-101"]').click();
    await expect(menu).toHaveCount(0);
    await page.keyboard.press('Escape');

    await statusButton('ENG-102').click();
    await expect(menu).toHaveCount(1);
    const bubbleBox = (await page.locator('[data-status-bubble="ENG-101"]').boundingBox())!;
    await page.mouse.move(bubbleBox.x + bubbleBox.width / 2, bubbleBox.y + bubbleBox.height / 2);
    await page.mouse.down();
    await expect(menu).toHaveCount(0);
    // Release elsewhere so the press does not count as a click that opens the status menu
    await page.mouse.move(5, 300);
    await page.mouse.up();
    expect(updates).toHaveLength(5);

    // ---- Title rename ----
    const title101 = page.locator('[data-task-title="ENG-101"]');
    await title101.click();
    await expect(titleInput).toHaveCount(0);
    await expect(page.getByText('Manifold details')).toHaveCount(0);

    // Double-click + Enter saves
    await title101.dblclick();
    await expect(titleInput).toBeFocused();
    await expect(titleInput).toHaveValue('Design valve manifold');
    await page.keyboard.press('ArrowDown');
    await expect(titleInput).toBeFocused();
    await titleInput.fill('Design valve manifold v2');
    await page.keyboard.press('Enter');
    await expect(titleInput).toHaveCount(0);
    await expect(title101).toHaveText('Design valve manifold v2');
    expect(updates[5]).toEqual({ id: 'uuid-1', title: 'Design valve manifold v2' });

    // Escape cancels and restores the original title without a request
    await title101.dblclick();
    await titleInput.fill('Throwaway title');
    await page.keyboard.press('Escape');
    await expect(titleInput).toHaveCount(0);
    await expect(title101).toHaveText('Design valve manifold v2');
    expect(updates).toHaveLength(6);

    // Empty and unchanged titles are ignored cleanly
    await title101.dblclick();
    await titleInput.fill('   ');
    await page.keyboard.press('Enter');
    await expect(title101).toHaveText('Design valve manifold v2');
    await title101.dblclick();
    await page.keyboard.press('Enter');
    await expect(title101).toHaveText('Design valve manifold v2');
    expect(updates).toHaveLength(6);

    // Blur saves
    const title102 = page.locator('[data-task-title="ENG-102"]');
    await title102.dblclick();
    await titleInput.fill('Pressure test rig (blur)');
    await page.mouse.click(5, 300);
    await expect(title102).toHaveText('Pressure test rig (blur)');
    expect(updates[6]).toEqual({ id: 'uuid-2', title: 'Pressure test rig (blur)' });

    // Failed rename rolls back
    failNextUpdate = true;
    await title102.dblclick();
    await titleInput.fill('Will not stick');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Failed to rename issue: Permission denied')).toBeVisible();
    await expect(title102).toHaveText('Pressure test rig (blur)');

    expect(errors).toEqual([]);
  });

  test('edits due dates inline from the Due column without opening DetailPanel and keeps locked rows read-only', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const dueUpdates: Array<{ id: string; dueDate: string }> = [];

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
        variables?: Record<string, unknown>;
      } | null;
      if (await defaultScheduleMock.handle(route, payload)) return;
      const query = payload?.query ?? '';

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
                    {
                      id: 'uuid-comm-2',
                      identifier: 'COMM-102',
                      title: 'Hand over documentation',
                      description: `${startTagOffsetDays(3)}\nHandover details`,
                      dueDate: null,
                      url: 'https://linear.app/bluecoreenergy/issue/COMM-102',
                      priority: 3,
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
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { workflowStates: { nodes: [{ id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 }] } },
          }),
        });
        return;
      }

      if (query.includes('issueUpdate')) {
        dueUpdates.push({
          id: String(payload?.variables?.id ?? ''),
          dueDate: String(payload?.variables?.dueDate ?? ''),
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { issueUpdate: { success: true } } }),
        });
        return;
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    // A date in the same calendar month as `base` so the picker shows it without paging
    const sameMonthNeighbor = (offset: number) => {
      const base = localOffsetDate(offset);
      const next = localOffsetDate(offset + 1);
      return next.getMonth() === base.getMonth() ? offset + 1 : offset - 1;
    };

    await page.goto('/app');
    const popover = page.locator('[data-popover="due-date"]');
    const dueCell101 = page.locator('button[data-due-cell="COMM-101"]');
    const dueCell102 = page.locator('button[data-due-cell="COMM-102"]');
    const dueCellCtrl = page.locator('button[data-due-cell="CTRL-42"]');
    const bar101 = page.locator('[data-task-bar="COMM-101"]');
    const detailText = page.getByText('Loop check details');

    await expect(bar101).toBeVisible();
    await expect(page.locator('tr[data-task-id="CTRL-42"]')).toBeVisible();

    // 1. Locked external rows are strictly non-editable; local rows are editable
    await expect(dueCell101).toBeVisible();
    await expect(dueCell102).toBeVisible();
    await expect(dueCellCtrl).toHaveCount(0);
    await expect(page.locator('tr[data-task-id="CTRL-42"] button[aria-haspopup]')).toHaveCount(0);

    // 2. Clicking the Due cell opens the picker (portalled to <body>), not DetailPanel
    await dueCell101.click();
    await expect(popover).toBeVisible();
    await expect(popover.locator('xpath=..')).toHaveJSProperty('tagName', 'BODY');
    await expect(popover.locator('[data-day][data-selected="true"]')).toHaveAttribute('data-day', isoOffsetDays(10));
    await expect(detailText).toHaveCount(0);

    // Keys typed inside the popover do not trigger global shortcuts (zoom) or row navigation
    const widthBeforeKeys = (await bar101.boundingBox())!.width;
    await page.keyboard.press('+');
    await page.keyboard.press('r');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    expect((await bar101.boundingBox())!.width).toBe(widthBeforeKeys);
    await expect(popover).toBeVisible();
    await expect(detailText).toHaveCount(0);

    // 3. Escape closes the picker without mutating anything or opening the panel
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(detailText).toHaveCount(0);
    expect(dueUpdates).toEqual([]);

    // 4. Clicking outside also closes it
    await dueCell101.click();
    await expect(popover).toBeVisible();
    await page.mouse.click(700, 8);
    await expect(popover).toHaveCount(0);

    // 5. Picking a new date updates the cell, the bar, and sends the Linear mutation
    const barBefore = (await bar101.boundingBox())!;
    const newOffset = sameMonthNeighbor(10);
    await dueCell101.click();
    await popover.locator(`[data-day="${isoOffsetDays(newOffset)}"] button`).click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByText('Due date updated')).toBeVisible();
    expect(dueUpdates).toEqual([{ id: 'uuid-comm-1', dueDate: isoOffsetDays(newOffset) }]);
    await expect.poll(async () => (await bar101.boundingBox())!.width).not.toBe(barBefore.width);
    const barAfter = (await bar101.boundingBox())!;
    if (newOffset > 10) expect(barAfter.width).toBeGreaterThan(barBefore.width);
    else expect(barAfter.width).toBeLessThan(barBefore.width);
    await expect(detailText).toHaveCount(0);

    // 5b. Re-selecting the current explicit date closes the picker without a mutation
    await dueCell101.click();
    await expect(popover.locator('[data-day][data-selected="true"]')).toHaveAttribute(
      'data-day',
      isoOffsetDays(newOffset),
    );
    await popover.locator(`[data-day="${isoOffsetDays(newOffset)}"] button`).click();
    await expect(popover).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(dueUpdates).toHaveLength(1);

    // 5c. Opening another row's picker closes the first (clicks that stopPropagation still dismiss).
    // Open the lower row first so its downward-opening popover doesn't cover the upper row's Due cell.
    await dueCell102.click();
    await expect(popover).toHaveCount(1);
    await expect(popover).toHaveAttribute('data-popover-task', 'COMM-102');
    await dueCell101.click();
    await expect(popover).toHaveCount(1);
    await expect(popover).toHaveAttribute('data-popover-task', 'COMM-101');
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);

    // 5d. Mousedown on a task bar (which stops propagation) closes an open picker
    await dueCell101.click();
    await expect(popover).toHaveCount(1);
    await bar101.click();
    await expect(popover).toHaveCount(0);
    await expect(detailText).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detailText).toHaveCount(0);
    expect(dueUpdates).toHaveLength(1);

    // 5e. Scrolling the chart so the Due cell moves away closes the picker
    await dueCell101.click();
    await expect(popover).toHaveCount(1);
    await dueCell101.evaluate((el) => {
      let node: HTMLElement | null = el.parentElement;
      while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
      if (!node) throw new Error('no scroll container');
      const spacer = document.createElement('div');
      spacer.style.height = '2000px';
      node.appendChild(spacer);
      node.scrollTop = 40;
      setTimeout(() => spacer.remove(), 1000);
    });
    await expect(popover).toHaveCount(0);
    expect(dueUpdates).toHaveLength(1);
    await page.waitForTimeout(1100);

    // 6. Implicit (project target) due dates are editable and become explicit
    await expect(page.locator('tr[data-task-id="COMM-102"] td').filter({ hasText: '~' })).toBeVisible();
    await dueCell102.click();
    await expect(popover).toBeVisible();
    await expect(popover.locator('[data-day][data-selected="true"]')).toHaveAttribute('data-day', isoOffsetDays(20));
    const implicitTarget = sameMonthNeighbor(20);
    await popover.locator(`[data-day="${isoOffsetDays(implicitTarget)}"] button`).click();
    await expect(popover).toHaveCount(0);
    await expect.poll(() => dueUpdates[1]).toEqual({ id: 'uuid-comm-2', dueDate: isoOffsetDays(implicitTarget) });
    await expect(page.locator('tr[data-task-id="COMM-102"] td').filter({ hasText: '~' })).toHaveCount(0);
    await expect(page.getByText('Handover details')).toHaveCount(0);

    // 7. Unlocking external edits makes the external Due cell editable too
    await page.getByRole('button', { name: 'Edit external' }).click();
    await expect(dueCellCtrl).toBeVisible();
    await dueCellCtrl.click();
    await expect(popover).toBeVisible();
    await popover.locator(`[data-day="${isoOffsetDays(sameMonthNeighbor(6))}"] button`).click();
    await expect(popover).toHaveCount(0);
    await expect
      .poll(() => dueUpdates[2])
      .toEqual({ id: 'uuid-ctrl-42', dueDate: isoOffsetDays(sameMonthNeighbor(6)) });
    await expect(page.getByText('PLC cabinet wiring')).toHaveCount(0);

    // 8. Locking again removes the editor
    await page.getByRole('button', { name: 'Editing external' }).click();
    await expect(dueCellCtrl).toHaveCount(0);
    expect(dueUpdates).toHaveLength(3);

    expect(errors).toEqual([]);
  });

  test('edits start dates inline from the Start column without opening DetailPanel and keeps locked rows read-only', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const scheduleCreates: Array<{ issueId: string; body: string }> = [];
    const scheduleUpdates: Array<{ commentId: string; body: string }> = [];
    const scheduleDeletes: Array<{ id: string }> = [];
    const descUpdates: Array<{ id: string; description: string }> = [];

    const today = new Date();
    const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const targetYear = nextMonth.getFullYear();
    const targetMonth = nextMonth.getMonth();

    const formatYMD = (year: number, month: number, day: number) => {
      const mm = String(month + 1).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      return `${year}-${mm}-${dd}`;
    };

    const comm101Start = formatYMD(targetYear, targetMonth, 2);
    const comm101NewStart = formatYMD(targetYear, targetMonth, 5);
    const comm101Due = formatYMD(targetYear, targetMonth, 10);
    const comm101AfterDue = formatYMD(targetYear, targetMonth, 11);

    const comm102Due = formatYMD(targetYear, targetMonth, 20);
    const comm102NewStart = formatYMD(targetYear, targetMonth, 15);

    const comm103Start = formatYMD(targetYear, targetMonth, 4);

    const ctrlDue = formatYMD(targetYear, targetMonth, 8);
    const ctrlStart = formatYMD(targetYear, targetMonth, 3);

    await page.addInitScript(() => {
      localStorage.setItem('gantt_onboarding_done', '1');
      localStorage.setItem('gantt_theme', 'dark');
      localStorage.setItem('linear_selected_project', 'proj-1');
      localStorage.setItem('gantt_columns', JSON.stringify(['id', 'task', 'assignee', 'status', 'start', 'due']));
    });

    await page.route('**/api/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'dev@bluecore.energy', linearConnected: true }),
      });
    });

    let comm101Comments = [
      {
        id: 'comment-comm-1',
        body: `**GanttSmart Schedule**\nstart: ${comm101Start}\nend: ${comm101Due}`,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    let comm102Comments: Array<{ id: string; body: string; createdAt: string; updatedAt: string }> = [];
    let comm103Comments = [
      {
        id: 'comment-comm-3',
        body: `**GanttSmart Schedule**\nstart: ${comm103Start}`,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    let comm101Desc = `start: ${comm101Start}\nLoop check details`;

    await page.route('**/api/linear/graphql', async (route) => {
      const payload = route.request().postDataJSON() as {
        query?: string;
        variables?: Record<string, unknown>;
      } | null;
      const query = payload?.query ?? '';
      const variables = payload?.variables ?? {};

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
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              project: {
                name: 'Commissioning',
                startDate: comm101Start,
                targetDate: comm102Due,
                projectMilestones: { nodes: [] },
                issues: {
                  nodes: [
                    {
                      id: 'uuid-comm-1',
                      identifier: 'COMM-101',
                      title: 'Run commissioning loop check',
                      description: comm101Desc,
                      dueDate: comm101Due,
                      url: 'https://linear.app/bluecoreenergy/issue/COMM-101',
                      priority: 2,
                      state: { name: 'Todo', type: 'unstarted' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Andrew Phillips' },
                      team: { id: 'team-comm' },
                      projectMilestone: null,
                    },
                    {
                      id: 'uuid-comm-2',
                      identifier: 'COMM-102',
                      title: 'Hand over documentation',
                      description: 'Handover details without start tag',
                      dueDate: comm102Due,
                      url: 'https://linear.app/bluecoreenergy/issue/COMM-102',
                      priority: 3,
                      state: { name: 'Todo', type: 'unstarted' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Andrew Phillips' },
                      team: { id: 'team-comm' },
                      projectMilestone: null,
                    },
                    {
                      id: 'uuid-comm-3',
                      identifier: 'COMM-103',
                      title: 'Calibrate pressure transmitter',
                      description: 'No due date set',
                      dueDate: null,
                      url: 'https://linear.app/bluecoreenergy/issue/COMM-103',
                      priority: 4,
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
                            description: `start: ${ctrlStart}\nPLC cabinet wiring`,
                            dueDate: ctrlDue,
                            url: 'https://linear.app/bluecoreenergy/issue/CTRL-42',
                            priority: 1,
                            completedAt: null,
                            canceledAt: null,
                            state: { name: 'In Progress', type: 'started' },
                            assignee: { name: 'Carol Vance' },
                            team: { id: 'team-ctrl' },
                            project: { id: 'proj-2', name: 'Controls', targetDate: comm102Due },
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

      if (query.includes('ScheduleComments')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              issues: {
                nodes: [
                  { id: 'uuid-comm-1', comments: { nodes: comm101Comments } },
                  { id: 'uuid-comm-2', comments: { nodes: comm102Comments } },
                  { id: 'uuid-comm-3', comments: { nodes: comm103Comments } },
                ],
              },
            },
          }),
        });
        return;
      }

      if (query.includes('IssueSchedule')) {
        const id = String(variables.id ?? '');
        const isComm1 = id === 'uuid-comm-1';
        const isComm3 = id === 'uuid-comm-3';
        const comments = isComm1 ? comm101Comments : isComm3 ? comm103Comments : comm102Comments;
        const dueDate = isComm1 ? comm101Due : isComm3 ? null : comm102Due;
        const description = isComm1 ? comm101Desc : isComm3 ? 'No due date set' : 'Handover details without start tag';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              issue: {
                description,
                dueDate,
                updatedAt: '2026-01-01T00:00:00Z',
                comments: { nodes: comments },
              },
            },
          }),
        });
        return;
      }

      if (query.includes('commentCreate')) {
        const body = String(variables.body ?? '');
        const issueId = String(variables.issueId ?? '');
        scheduleCreates.push({ issueId, body });
        const newComment = {
          id: `comment-${Date.now()}`,
          body,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        if (issueId === 'uuid-comm-1') comm101Comments.push(newComment);
        else if (issueId === 'uuid-comm-3') comm103Comments.push(newComment);
        else comm102Comments.push(newComment);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { commentCreate: { success: true } } }),
        });
        return;
      }

      if (query.includes('commentUpdate')) {
        const commentId = String(variables.commentId ?? '');
        const body = String(variables.body ?? '');
        scheduleUpdates.push({ commentId, body });
        for (const c of [...comm101Comments, ...comm102Comments, ...comm103Comments]) {
          if (c.id === commentId) {
            c.body = body;
            c.updatedAt = new Date().toISOString();
          }
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { commentUpdate: { success: true } } }),
        });
        return;
      }

      if (query.includes('commentDelete')) {
        const id = String(variables.id ?? '');
        scheduleDeletes.push({ id });
        comm101Comments = comm101Comments.filter((c) => c.id !== id);
        comm102Comments = comm102Comments.filter((c) => c.id !== id);
        comm103Comments = comm103Comments.filter((c) => c.id !== id);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { commentDelete: { success: true } } }),
        });
        return;
      }

      if (query.includes('issueUpdate')) {
        const id = String(variables.id ?? '');
        const desc = String(variables.description ?? '');
        descUpdates.push({ id, description: desc });
        if (id === 'uuid-comm-1') comm101Desc = desc;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { issueUpdate: { success: true } } }),
        });
        return;
      }

      if (query.includes('workflowStates')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { workflowStates: { nodes: [{ id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 }] } },
          }),
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
    const popover = page.locator('[data-popover="start-date"]');
    const startCell101 = page.locator('button[data-start-cell="COMM-101"]');
    const startCell102 = page.locator('button[data-start-cell="COMM-102"]');
    const startCell103 = page.locator('button[data-start-cell="COMM-103"]');
    const startCellCtrl = page.locator('button[data-start-cell="CTRL-42"]');
    const bar101 = page.locator('[data-task-bar="COMM-101"]');
    const bar102 = page.locator('[data-task-bar="COMM-102"]');
    const detailText = page.getByText('Loop check details');

    await expect(bar101).toBeVisible();
    await expect(bar102).toBeVisible();
    await expect(page.locator('tr[data-task-id="CTRL-42"]')).toBeVisible();

    // 1. Locked external rows are strictly non-editable (render as span, no button); local rows are editable
    await expect(startCell101).toBeVisible();
    await expect(startCell102).toBeVisible();
    await expect(startCellCtrl).toHaveCount(0);
    await expect(page.locator('span[data-start-cell="CTRL-42"]')).toBeVisible();

    // 2. COMM-102 initially has no start date, displaying "—"
    await expect(startCell102).toHaveText('—');

    // 3. Clicking start cell for COMM-102 opens the picker without opening DetailPanel
    await startCell102.click();
    await expect(popover).toBeVisible();
    await expect(popover.locator('xpath=..')).toHaveJSProperty('tagName', 'BODY');
    await expect(popover.locator('[data-day][data-selected="true"]')).toHaveCount(0);
    // Since COMM-102 has no start date yet, Clear button should not be present
    await expect(popover.locator('[data-clear-date]')).toHaveCount(0);
    await expect(detailText).toHaveCount(0);

    // 4. Escape dismisses the picker
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);

    // 5. Adding a start date to COMM-102 from "—" updates cell, expands bar, and calls Linear mutation
    const bar102Before = (await bar102.boundingBox())!;
    await startCell102.click();
    await popover.locator(`[data-day="${comm102NewStart}"] button`).click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByText('Start date updated')).toBeVisible();
    await expect(startCell102).not.toHaveText('—');
    await expect.poll(() => scheduleCreates.length).toBe(1);
    expect(scheduleCreates[0].body).toContain(`start: ${comm102NewStart}`);
    const bar102After = (await bar102.boundingBox())!;
    expect(bar102After.width).toBeLessThan(bar102Before.width);

    // 6. Changing an existing start date on COMM-101
    const bar101Before = (await bar101.boundingBox())!;
    await startCell101.click();
    await expect(popover).toBeVisible();
    await expect(popover.locator('[data-day][data-selected="true"]')).toHaveAttribute('data-day', comm101Start);
    // Clear button is present because COMM-101 has a start date
    await expect(popover.locator('[data-clear-date]')).toBeVisible();
    await popover.locator(`[data-day="${comm101NewStart}"] button`).click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByText('Start date updated')).toBeVisible();
    await expect.poll(() => scheduleUpdates.length).toBe(1);
    expect(scheduleUpdates[0].body).toContain(`start: ${comm101NewStart}`);
    const bar101After = (await bar101.boundingBox())!;
    expect(bar101After.width).toBeLessThan(bar101Before.width);

    // 6b. Re-selecting the current start date closes the picker without mutating
    await startCell101.click();
    await expect(popover.locator('[data-day][data-selected="true"]')).toHaveAttribute('data-day', comm101NewStart);
    await popover.locator(`[data-day="${comm101NewStart}"] button`).click();
    await expect(popover).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(scheduleUpdates).toHaveLength(1);

    // 7. Dates after due date are disabled in picker (COMM-101 due date is comm101Due)
    await startCell101.click();
    await expect(popover).toBeVisible();
    const afterDueDay = popover.locator(`[data-day="${comm101AfterDue}"] button`);
    await expect(afterDueDay).toHaveCount(1);
    await expect(afterDueDay).toBeDisabled();

    // 8. Clearing the start date via the Clear button removes start date, widens bar back to today, and strips legacy tag
    await popover.locator('[data-clear-date]').click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByText('Start date cleared')).toBeVisible();
    await expect(startCell101).toHaveText('—');
    const bar101Cleared = (await bar101.boundingBox())!;
    expect(bar101Cleared.width).toBeGreaterThan(bar101After.width);
    // Verify comment update removed start: and description update stripped legacy start tag
    await expect.poll(() => scheduleUpdates.length).toBe(2);
    expect(scheduleUpdates[1].body).not.toContain('start:');
    expect(scheduleUpdates[1].body).toContain(`end: ${comm101Due}`);
    await expect.poll(() => descUpdates.length).toBe(1);
    expect(descUpdates[0].description).not.toContain('start:');

    // 8b. Clearing a task with only a start date (COMM-103) deletes the schedule comment
    await startCell103.click();
    await expect(popover.locator('[data-clear-date]')).toBeVisible();
    await popover.locator('[data-clear-date]').click();
    await expect(popover).toHaveCount(0);
    await expect.poll(() => scheduleDeletes.length).toBe(1);
    expect(scheduleDeletes[0].id).toBe('comment-comm-3');

    // 9. Viewport clamping: popover does not overflow screen
    await page.setViewportSize({ width: 780, height: 667 });
    await startCell102.click();
    await expect(popover).toBeVisible();
    const popBox = (await popover.boundingBox())!;
    expect(popBox.x).toBeGreaterThanOrEqual(8);
    expect(popBox.x + popBox.width).toBeLessThanOrEqual(780 - 8);
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);

    // 10. Unlocking external edits makes external Start cell editable
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole('button', { name: 'Edit external' }).click();
    await expect(startCellCtrl).toBeVisible();
    await page.getByRole('button', { name: 'Editing external' }).click();
    await expect(startCellCtrl).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
