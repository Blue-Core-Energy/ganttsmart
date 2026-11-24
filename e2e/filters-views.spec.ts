import { expect, test } from '@playwright/test';
import {
  blockFonts,
  createScheduleMock,
  dismissToasts as dismissToastsHelper,
  isoOffsetDays,
  startTagOffsetDays,
  trackErrors,
} from './helpers/index.js';

let defaultScheduleMock = createScheduleMock();

test.describe('GanttSmart GCP app', () => {
  test.beforeEach(async ({ page }) => {
    defaultScheduleMock = createScheduleMock();
    await blockFonts(page);
  });

  test('renders Gantt chart, filters tasks, switches time scale, opens detail panel, and toggles theme', async ({
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

    // Gantt chart renders both tasks and project header
    await expect(page.getByText('Demo Project').first()).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-102"]')).toBeVisible();

    // Account menu nests export options under a single Export item
    const accountButton = page.getByTitle('Account');
    await accountButton.click();
    const exportButton = page.getByRole('button', { name: 'Export', exact: true });
    await expect(exportButton).toBeVisible();
    await expect(exportButton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('group', { name: 'Export options' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Disconnect Linear' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out of GanttSmart', exact: true })).toBeVisible();
    await expect(page.getByText('Signs out of GanttSmart only, not Google.')).toHaveCount(0);

    // Opening Export expands the inline submenu with role="group"
    await exportButton.click();
    await expect(exportButton).toHaveAttribute('aria-expanded', 'true');
    const exportGroup = page.getByRole('group', { name: 'Export options' });
    await expect(exportGroup).toBeVisible();
    await expect(exportGroup.getByRole('button', { name: 'Export as PNG' })).toBeVisible();
    await expect(exportGroup.getByRole('button', { name: 'Export as PDF' })).toBeVisible();
    await expect(exportGroup.getByRole('button', { name: 'Print' })).toBeVisible();

    // Assert inline placement: submenu renders directly below Export disclosure button
    const exportBtnBox = (await exportButton.boundingBox())!;
    const submenuBox = (await exportGroup.boundingBox())!;
    expect(submenuBox.y).toBeGreaterThanOrEqual(exportBtnBox.y + exportBtnBox.height - 1);

    // Keyboard Escape closes only the Export submenu and returns focus to Export
    await page.keyboard.press('Escape');
    await expect(exportButton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('group', { name: 'Export options' })).toHaveCount(0);
    await expect(exportButton).toBeFocused();
    await expect(page.getByRole('button', { name: 'Disconnect Linear' })).toBeVisible();

    // Pressing Escape again closes the account menu and returns focus to Account button
    await page.keyboard.press('Escape');
    await expect(exportButton).toHaveCount(0);
    await expect(accountButton).toBeFocused();

    // Mobile viewport (375px): expandable inline submenu stays completely inside viewport without horizontal overflow
    await page.setViewportSize({ width: 375, height: 812 });
    await accountButton.click();
    const mobileExportButton = page.getByRole('button', { name: 'Export', exact: true });
    await expect(mobileExportButton).toBeVisible();
    await mobileExportButton.click();
    await expect(mobileExportButton).toHaveAttribute('aria-expanded', 'true');

    const mobileSubmenu = page.getByRole('group', { name: 'Export options' });
    await expect(mobileSubmenu).toBeVisible();
    await expect(mobileSubmenu.getByRole('button', { name: 'Export as PNG' })).toBeVisible();
    await expect(mobileSubmenu.getByRole('button', { name: 'Export as PDF' })).toBeVisible();
    await expect(mobileSubmenu.getByRole('button', { name: 'Print' })).toBeVisible();

    const mobileExportBtnBox = (await mobileExportButton.boundingBox())!;
    const mobileSubmenuBox = (await mobileSubmenu.boundingBox())!;
    expect(mobileSubmenuBox.x).toBeGreaterThanOrEqual(0);
    expect(mobileSubmenuBox.x + mobileSubmenuBox.width).toBeLessThanOrEqual(375);
    expect(mobileSubmenuBox.y).toBeGreaterThanOrEqual(mobileExportBtnBox.y + mobileExportBtnBox.height - 1);

    const docOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(docOverflow).toBe(true);

    // Escape closes submenu first, then account menu on mobile too, returning focus to Account button
    await page.keyboard.press('Escape');
    await expect(mobileExportButton).toHaveAttribute('aria-expanded', 'false');
    await expect(mobileExportButton).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(mobileExportButton).toHaveCount(0);
    await expect(accountButton).toBeFocused();

    // Restore desktop viewport for remaining checks
    await page.setViewportSize({ width: 1280, height: 800 });

    // Search filters task bars
    const search = page.getByPlaceholder('Search tasks…');
    await search.fill('manifold');
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-102"]')).toHaveCount(0);
    await search.fill('');
    await expect(page.locator('[data-task-bar="ENG-102"]')).toBeVisible();

    // Assignee and date range live in the single Filter dropdown
    const filterButton = page.getByRole('button', { name: 'Filter', exact: true });
    await filterButton.click();
    await expect(page.getByRole('group', { name: 'Filters' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Date range' })).toBeVisible();

    await page.getByRole('button', { name: 'Any assignee' }).click();
    await page.getByRole('option', { name: /Nate Jones/ }).click();
    await expect(page.locator('[data-task-bar="ENG-102"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-101"]')).toHaveCount(0);
    await expect(
      page
        .locator('div')
        .filter({ hasText: /^1Active$/ })
        .first(),
    ).toBeVisible();
    await expect(filterButton).toHaveAttribute('title', 'Filter tasks — 1 active');

    // The open panel sits below the chip row, so "Clear all" stays clickable
    const panel = page.getByRole('group', { name: 'Filters' });
    const clearAll = page.getByRole('button', { name: 'Clear all' });
    const panelBox = await panel.boundingBox();
    const clearBox = await clearAll.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(clearBox).not.toBeNull();
    expect(clearBox!.y + clearBox!.height).toBeLessThanOrEqual(panelBox!.y);
    await clearAll.click({ timeout: 5000 });
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();
    await expect(
      page
        .locator('div')
        .filter({ hasText: /^2Active$/ })
        .first(),
    ).toBeVisible();
    await expect(filterButton).toHaveAttribute('title', 'Filter tasks by assignee, status, date range and completion');

    // Escape returns focus to the trigger and closes the panel
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(filterButton).toBeFocused();

    // Header has no time-scale or zoom buttons; keyboard + / - still zooms
    await expect(page.getByRole('button', { name: 'week', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'day', exact: true })).toHaveCount(0);
    await expect(page.locator('button[title^="Zoom "]')).toHaveCount(0);
    const barBeforeKeyZoom = (await page.locator('[data-task-bar="ENG-101"]').boundingBox())!.width;
    await page.keyboard.press('+');
    const barAfterKeyZoom = (await page.locator('[data-task-bar="ENG-101"]').boundingBox())!.width;
    expect(barAfterKeyZoom).toBeGreaterThan(barBeforeKeyZoom);
    await page.keyboard.press('-');
    expect((await page.locator('[data-task-bar="ENG-101"]').boundingBox())!.width).toBeCloseTo(barBeforeKeyZoom, 0);

    // Clicking a task bar opens DetailPanel and Escape closes it
    await page.locator('[data-task-bar="ENG-101"]').click();
    await expect(page.getByText('Manifold details')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Manifold details')).toHaveCount(0);

    // Theme toggle flips dark/light class on <html>, and the inline colours follow it
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    const chartColours = async () => {
      await page.locator('[data-task-bar="ENG-101"]').click();
      const badge = page.locator('[data-priority-badge]');
      await expect(badge).toBeVisible();
      const colours = {
        bar: await page.locator('[data-task-bar="ENG-102"]').evaluate((el) => getComputedStyle(el).backgroundImage),
        priority: await badge.evaluate((el) => getComputedStyle(el).color),
      };
      await page.keyboard.press('Escape');
      await expect(badge).toHaveCount(0);
      return colours;
    };
    const darkColours = await chartColours();
    await page.getByTitle('Account').click();
    await page.locator('button[title*="mode"]').click();
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    const lightColours = await chartColours();
    expect(darkColours.priority).toBe('rgb(249, 115, 22)'); // --color-high, dark theme
    expect(lightColours.priority).toBe('rgb(234, 88, 12)'); // --color-high, light theme
    expect(lightColours.bar).not.toBe(darkColours.bar);

    expect(errors).toEqual([]);
  });

  test('ignores duplicate and canceled issues across schedule, unscheduled list, stats, filters, and dependencies', async ({
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
                targetDate: null,
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
                      canceledAt: null,
                      assignee: { name: 'Andrew Phillips' },
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
                      canceledAt: null,
                      assignee: { name: 'Nate Jones' },
                      team: { id: 'team-1' },
                      projectMilestone: null,
                    },
                    {
                      id: 'uuid-3',
                      identifier: 'ENG-103',
                      title: 'Duplicate valve manifold',
                      description: 'Should be hidden',
                      dueDate: isoOffsetDays(6),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-103',
                      priority: 2,
                      state: { name: 'Duplicate', type: 'duplicate' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      canceledAt: '2026-01-02T00:00:00Z',
                      assignee: { name: 'Ghost User' },
                      team: { id: 'team-1' },
                      projectMilestone: null,
                    },
                    {
                      id: 'uuid-4',
                      identifier: 'ENG-104',
                      title: 'Canceled rig build',
                      description: 'Should also be hidden',
                      dueDate: isoOffsetDays(7),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-104',
                      priority: 3,
                      state: { name: 'Rejected', type: 'canceled' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      canceledAt: '2026-01-03T00:00:00Z',
                      assignee: { name: 'Ghost User' },
                      team: { id: 'team-1' },
                      projectMilestone: null,
                    },
                    {
                      id: 'uuid-5',
                      identifier: 'ENG-105',
                      title: 'Unscheduled duplicate task',
                      description: '',
                      dueDate: null,
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-105',
                      priority: 4,
                      state: { name: 'Duplicate', type: 'backlog' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      canceledAt: null,
                      assignee: { name: 'Nate Jones' },
                      team: { id: 'team-1' },
                      projectMilestone: null,
                    },
                    {
                      id: 'uuid-6',
                      identifier: 'ENG-106',
                      title: 'Unscheduled active task',
                      description: '',
                      dueDate: null,
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-106',
                      priority: 4,
                      state: { name: 'Backlog', type: 'backlog' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      canceledAt: null,
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
                    relations: {
                      nodes: [
                        { type: 'blocks', relatedIssue: { identifier: 'ENG-102' } },
                        {
                          type: 'blocks',
                          relatedIssue: {
                            identifier: 'ENG-103',
                            canceledAt: '2026-01-02T00:00:00Z',
                            state: { name: 'Duplicate', type: 'duplicate' },
                          },
                        },
                      ],
                    },
                    children: {
                      nodes: [
                        {
                          id: 'c1',
                          completedAt: '2026-01-03T00:00:00Z',
                          canceledAt: null,
                          state: { name: 'Done', type: 'completed' },
                        },
                        { id: 'c2', completedAt: null, canceledAt: null, state: { name: 'Todo', type: 'unstarted' } },
                        {
                          id: 'c3',
                          completedAt: null,
                          canceledAt: '2026-01-02T00:00:00Z',
                          state: { name: 'Duplicate', type: 'duplicate' },
                        },
                      ],
                    },
                  },
                  {
                    id: 'uuid-2',
                    identifier: 'ENG-102',
                    relations: { nodes: [{ type: 'blocked_by', relatedIssue: { identifier: 'ENG-101' } }] },
                    children: { nodes: [] },
                  },
                  {
                    id: 'uuid-6',
                    identifier: 'ENG-106',
                    relations: { nodes: [] },
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
                  { id: 'st-4', name: 'Duplicate', type: 'duplicate', position: 3 },
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

    // Only active scheduled tasks render on the chart
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-102"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-103"]')).toHaveCount(0);
    await expect(page.locator('[data-task-bar="ENG-104"]')).toHaveCount(0);
    await expect(page.getByText('Duplicate valve manifold')).toHaveCount(0);
    await expect(page.getByText('Canceled rig build')).toHaveCount(0);

    // Unscheduled section only includes the active unscheduled issue, not the duplicate one
    await expect(page.getByText('Unscheduled active task')).toBeVisible();
    await expect(page.getByText('Unscheduled duplicate task')).toHaveCount(0);

    // The section sits above the schedule table, keeps its count badge, and still collapses in place
    const unscheduledSection = page.getByTestId('unscheduled-section');
    await expect(unscheduledSection).toHaveAttribute('data-export-hide', 'true');
    const unscheduledToggle = unscheduledSection.getByRole('button', { name: /Unscheduled/ });
    await expect(unscheduledSection.getByTestId('unscheduled-count')).toHaveText('1');

    // Small unscheduled lists are unaffected and take natural height well below 240px
    const smallListContainer = page.getByTestId('unscheduled-list-container');
    const smallHeight = await smallListContainer.evaluate((el) => el.clientHeight);
    const smallScrollHeight = await smallListContainer.evaluate((el) => el.scrollHeight);
    expect(smallHeight).toBeLessThan(200);
    expect(smallScrollHeight).toBeLessThanOrEqual(smallHeight + 1);

    const sectionBox = await unscheduledSection.boundingBox();
    const headerBox = await page.locator('thead').boundingBox();
    const firstRowBox = await page.locator('[data-task-bar="ENG-101"]').boundingBox();
    expect(sectionBox).not.toBeNull();
    expect(sectionBox!.y + sectionBox!.height).toBeLessThanOrEqual(headerBox!.y + 1);
    expect(headerBox!.y).toBeLessThan(firstRowBox!.y);
    await unscheduledToggle.click();
    await expect(page.getByText('Unscheduled active task')).toHaveCount(0);
    await expect(unscheduledSection.getByTestId('unscheduled-count')).toHaveText('1');
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();
    await unscheduledToggle.click();
    await expect(page.getByText('Unscheduled active task')).toBeVisible();

    // Summary row counts only the active unscheduled issue, matching the Unscheduled section badge
    await expect(
      page
        .locator('div')
        .filter({ hasText: /^1Unscheduled$/ })
        .first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Unscheduled\s*1\s*—/ })).toBeVisible();

    // Summary cards reflect only the 2 active scheduled tasks
    await expect(
      page
        .locator('div')
        .filter({ hasText: /^2Active$/ })
        .first(),
    ).toBeVisible();

    // Status filter, inside the Filter dropdown, excludes Duplicate / Rejected
    const filterButton = page.getByRole('button', { name: 'Filter', exact: true });
    await filterButton.click();
    const statusTrigger = page.getByRole('button', { name: 'Any status', exact: true });
    await statusTrigger.click();
    await expect(page.getByRole('option', { name: 'In Progress', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Todo', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Duplicate', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: 'Rejected', exact: true })).toHaveCount(0);
    await statusTrigger.click();
    await filterButton.click();
    await expect(page.getByRole('group', { name: 'Filters' })).toHaveCount(0);

    // DetailPanel excludes dependencies to ignored duplicate issues and excludes duplicate sub-issues
    await page.locator('[data-task-bar="ENG-101"]').click();
    await expect(page.getByText('Blocks ENG-102')).toBeVisible();
    await expect(page.getByText('Blocks ENG-103')).toHaveCount(0);
    await expect(page.getByText('1/2 (50%)')).toBeVisible();
    await page.keyboard.press('Escape');

    expect(errors).toEqual([]);
  });

  test('shows only the Unscheduled summary card when no scheduled issues exist', async ({ page }) => {
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

      const respond = (data: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });

      if (query.includes('projects(')) {
        await respond({ projects: { nodes: [{ id: 'proj-1', name: 'Demo Project' }] } });
        return;
      }

      if (query.includes('project(id:')) {
        await respond({
          project: {
            name: 'Demo Project',
            startDate: null,
            targetDate: null,
            projectMilestones: { nodes: [] },
            issues: {
              nodes: [
                {
                  id: 'uuid-1',
                  identifier: 'ENG-101',
                  title: 'Unscheduled backlog task',
                  description: '',
                  dueDate: null,
                  url: 'https://linear.app/bluecoreenergy/issue/ENG-101',
                  priority: 4,
                  state: { name: 'Backlog', type: 'backlog' },
                  createdAt: '2026-01-01T00:00:00Z',
                  completedAt: null,
                  canceledAt: null,
                  assignee: { name: 'Nate Jones' },
                  team: { id: 'team-1' },
                  projectMilestone: null,
                },
                {
                  id: 'uuid-2',
                  identifier: 'ENG-102',
                  title: 'Unscheduled todo task',
                  description: '',
                  dueDate: null,
                  url: 'https://linear.app/bluecoreenergy/issue/ENG-102',
                  priority: 4,
                  state: { name: 'Todo', type: 'unstarted' },
                  createdAt: '2026-01-01T00:00:00Z',
                  completedAt: null,
                  canceledAt: null,
                  assignee: { name: 'Nate Jones' },
                  team: { id: 'team-1' },
                  projectMilestone: null,
                },
                {
                  id: 'uuid-3',
                  identifier: 'ENG-103',
                  title: 'Unscheduled duplicate task',
                  description: '',
                  dueDate: null,
                  url: 'https://linear.app/bluecoreenergy/issue/ENG-103',
                  priority: 4,
                  state: { name: 'Duplicate', type: 'backlog' },
                  createdAt: '2026-01-01T00:00:00Z',
                  completedAt: null,
                  canceledAt: null,
                  assignee: { name: 'Nate Jones' },
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

      if (query.includes('relations')) {
        await respond({
          issues: {
            nodes: [
              { id: 'uuid-1', identifier: 'ENG-101', relations: { nodes: [] }, children: { nodes: [] } },
              { id: 'uuid-2', identifier: 'ENG-102', relations: { nodes: [] }, children: { nodes: [] } },
              { id: 'uuid-3', identifier: 'ENG-103', relations: { nodes: [] }, children: { nodes: [] } },
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
              { id: 'st-4', name: 'Duplicate', type: 'duplicate', position: 1 },
            ],
          },
        });
        return;
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');

    await expect(page.getByText('No issues with dates yet')).toBeVisible();
    await expect(page.getByText('2 issues need a due date', { exact: false })).toBeVisible();

    // Verify unscheduled issues are rendered in the expanded list with Schedule buttons
    await expect(page.getByText('Unscheduled backlog task')).toBeVisible();
    await expect(page.getByText('Unscheduled todo task')).toBeVisible();
    await expect(page.getByText('ENG-101')).toBeVisible();
    await expect(page.getByText('ENG-102')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule' })).toHaveCount(2);

    // Schedule table and export target are omitted when no tasks are scheduled
    await expect(page.locator('#gantt-export-target')).toHaveCount(0);
    await expect(page.locator('thead')).toHaveCount(0);

    // The summary row shows just the ignored-filtered Unscheduled count, with no misleading zeroed scheduled cards
    await expect(
      page
        .locator('div')
        .filter({ hasText: /^2Unscheduled$/ })
        .first(),
    ).toBeVisible();
    await expect(page.locator('div').filter({ hasText: /^0Active$/ })).toHaveCount(0);
    await expect(page.getByText('Total Span', { exact: true })).toHaveCount(0);
    await expect(page.getByText('In Progress', { exact: true })).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('keeps schedule table header visible in initial viewport when project has 20+ unscheduled issues', async ({
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

    const scheduledIssue = {
      id: 'uuid-sched-1',
      identifier: 'ENG-101',
      title: 'Design valve manifold',
      description: `${startTagOffsetDays(-2)}\nManifold details`,
      dueDate: isoOffsetDays(5),
      url: 'https://linear.app/bluecoreenergy/issue/ENG-101',
      priority: 2,
      state: { name: 'In Progress', type: 'started' },
      createdAt: '2026-01-01T00:00:00Z',
      completedAt: null,
      canceledAt: null,
      assignee: { name: 'Andrew Phillips' },
      team: { id: 'team-1' },
      projectMilestone: null,
    };

    const unscheduledIssues = Array.from({ length: 25 }, (_, idx) => {
      const num = idx + 1;
      const idStr = `ENG-2${String(num).padStart(2, '0')}`;
      return {
        id: `uuid-unscheduled-${num}`,
        identifier: idStr,
        title: `Unscheduled backlog item ${num}`,
        description: '',
        dueDate: null,
        url: `https://linear.app/bluecoreenergy/issue/${idStr}`,
        priority: 4,
        state: { name: 'Backlog', type: 'backlog' },
        createdAt: '2026-01-01T00:00:00Z',
        completedAt: null,
        canceledAt: null,
        assignee: { name: 'Nate Jones' },
        team: { id: 'team-1' },
        projectMilestone: null,
      };
    });

    const allIssues = [scheduledIssue, ...unscheduledIssues];

    await page.route('**/api/linear/graphql', async (route) => {
      const payload = route.request().postDataJSON() as { query?: string } | null;
      const query = payload?.query ?? '';
      if (await defaultScheduleMock.handle(route, payload)) return;

      const respond = (data: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });

      if (query.includes('projects(')) {
        await respond({ projects: { nodes: [{ id: 'proj-1', name: 'Demo Project' }] } });
        return;
      }

      if (query.includes('project(id:')) {
        await respond({
          project: {
            name: 'Demo Project',
            startDate: isoOffsetDays(-10),
            targetDate: null,
            projectMilestones: { nodes: [] },
            issues: { nodes: allIssues },
            doneIssues: { nodes: [] },
          },
        });
        return;
      }

      if (query.includes('relations')) {
        await respond({
          issues: {
            nodes: allIssues.map((n) => ({
              id: n.id,
              identifier: n.identifier,
              relations: { nodes: [] },
              children: { nodes: [] },
            })),
          },
        });
        return;
      }

      if (query.includes('workflowStates')) {
        await respond({
          workflowStates: {
            nodes: [
              { id: 'st-1', name: 'Backlog', type: 'backlog', position: 0 },
              { id: 'st-2', name: 'In Progress', type: 'started', position: 1 },
            ],
          },
        });
        return;
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');

    // Section exists, is excluded from export, and shows count of 25 issues
    const unscheduledSection = page.getByTestId('unscheduled-section');
    await expect(unscheduledSection).toBeVisible();
    await expect(unscheduledSection).toHaveAttribute('data-export-hide', 'true');
    await expect(unscheduledSection.getByTestId('unscheduled-count')).toHaveText('25');

    // The list container height is capped at 240px and scrolls
    const listContainer = page.getByTestId('unscheduled-list-container');
    await expect(listContainer).toBeVisible();
    const listClientHeight = await listContainer.evaluate((el) => el.clientHeight);
    const listScrollHeight = await listContainer.evaluate((el) => el.scrollHeight);
    expect(listClientHeight).toBeLessThanOrEqual(240);
    expect(listScrollHeight).toBeGreaterThan(listClientHeight);

    // Schedule table header remains visible within initial viewport without scrolling
    const thead = page.locator('thead');
    await expect(thead).toBeVisible();
    const theadBox = await thead.boundingBox();
    const viewport = page.viewportSize()!;
    expect(theadBox).not.toBeNull();
    expect(theadBox!.y).toBeGreaterThan(0);
    expect(theadBox!.y + theadBox!.height).toBeLessThan(viewport.height);

    // Scheduled task bar is also visible in initial viewport
    const taskBar = page.locator('[data-task-bar="ENG-101"]');
    await expect(taskBar).toBeVisible();
    const taskBarBox = await taskBar.boundingBox();
    expect(taskBarBox).not.toBeNull();
    expect(taskBarBox!.y + taskBarBox!.height).toBeLessThan(viewport.height);

    // Collapsing toggle hides the list and expands back
    const unscheduledToggle = unscheduledSection.getByRole('button', { name: /Unscheduled/ });
    await unscheduledToggle.click();
    await expect(listContainer).toHaveCount(0);
    await unscheduledToggle.click();
    await expect(page.getByTestId('unscheduled-list-container')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('renders completed tasks inline with active tasks in one unified section', async ({ page }) => {
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
            data: { projects: { nodes: [{ id: 'proj-1', name: 'Unified Roadmap' }] } },
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
                name: 'Unified Roadmap',
                startDate: isoOffsetDays(-14),
                targetDate: isoOffsetDays(20),
                projectMilestones: { nodes: [] },
                issues: {
                  nodes: [
                    {
                      id: 'uuid-active-1',
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
                      id: 'uuid-active-2',
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
                doneIssues: {
                  nodes: [
                    {
                      id: 'uuid-done-1',
                      identifier: 'ENG-100',
                      title: 'Finalize CAD model',
                      description: `${startTagOffsetDays(-10)}\nCAD completed early`,
                      dueDate: isoOffsetDays(-3),
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
                    id: 'uuid-done-1',
                    identifier: 'ENG-100',
                    relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ENG-101' } }] },
                    children: { nodes: [] },
                  },
                  {
                    id: 'uuid-active-1',
                    identifier: 'ENG-101',
                    relations: { nodes: [{ type: 'blocked_by', relatedIssue: { identifier: 'ENG-100' } }] },
                    children: { nodes: [] },
                  },
                  {
                    id: 'uuid-active-2',
                    identifier: 'ENG-102',
                    relations: { nodes: [] },
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

    // All 3 tasks (1 completed + 2 active) render in a single unified table with no separate Completed section
    const exportTarget = page.locator('#gantt-export-target');
    await expect(exportTarget.locator('table')).toHaveCount(1);
    const rows = exportTarget.locator('tbody tr[data-task-id]');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-task-id', 'ENG-100');
    await expect(rows.nth(1)).toHaveAttribute('data-task-id', 'ENG-101');
    await expect(rows.nth(2)).toHaveAttribute('data-task-id', 'ENG-102');

    // Completed task row and bar remain visually distinguishable inline
    const doneRow = page.locator('tr[data-task-id="ENG-100"]');
    await expect(doneRow).toHaveAttribute('data-task-done', 'true');
    const doneBar = page.locator('[data-task-bar="ENG-100"]');
    await expect(doneBar).toBeVisible();
    await expect(doneBar).toHaveClass(/\bbar-done\b/);
    await expect(doneBar).toContainText('✓ Done');

    // StatsRow reflects unified counts (2 active, 1 completed)
    await expect(
      page
        .locator('div')
        .filter({ hasText: /^2Active$/ })
        .first(),
    ).toBeVisible();
    const completedStat = page
      .locator('div')
      .filter({ hasText: /^1Completed$/ })
      .first();
    await expect(completedStat).toBeVisible();

    // No unscheduled issues, so the summary row has no Unscheduled card
    await expect(page.getByText('Unscheduled', { exact: true })).toHaveCount(0);

    // Dependency arrow renders between completed blocker ENG-100 and active ENG-101
    const arrow = exportTarget.locator('svg path[marker-end="url(#dep-arrow)"]');
    await expect(arrow).toHaveCount(1);

    // ...routed with rounded elbows, and painted beneath the task bars
    await expect(arrow).toHaveAttribute('d', /^M[-\d\s.HVQA,]+$/);
    const arrowLayers = await page.evaluate(() => {
      const svg = document.querySelector('#gantt-export-target svg path[data-arrow-source]')?.closest('svg');
      const bar = document.querySelector('[data-task-bar="ENG-101"]');
      return {
        svg: svg ? Number(getComputedStyle(svg).zIndex) : null,
        bar: bar ? Number(getComputedStyle(bar).zIndex) : null,
      };
    });
    expect(arrowLayers.svg).not.toBeNull();
    expect(arrowLayers.bar).not.toBeNull();
    expect(arrowLayers.svg!).toBeLessThan(arrowLayers.bar!);

    // ...and re-measured when zooming moves the bars, so it keeps landing on its target
    const arrowEndsOnTarget = async () => {
      const d = await arrow.getAttribute('d');
      const endX = Number(d!.trim().split(/\s+/).at(-1));
      const barBox = (await page.locator('[data-task-bar="ENG-101"]').boundingBox())!;
      const innerBox = (await exportTarget.locator('> div').boundingBox())!;
      return { endX, barLeft: barBox.x - innerBox.x, d };
    };
    const beforeZoom = await arrowEndsOnTarget();
    expect(beforeZoom.endX).toBeCloseTo(beforeZoom.barLeft, 0);
    await page.keyboard.press('+');
    await expect.poll(async () => (await arrow.getAttribute('d')) !== beforeZoom.d, { timeout: 5000 }).toBe(true);
    const afterZoom = await arrowEndsOnTarget();
    expect(afterZoom.endX).toBeCloseTo(afterZoom.barLeft, 0);
    await page.keyboard.press('-');
    await expect(arrow).toBeVisible();

    // IT-105: Click arrow to highlight connected issues, Escape/background to clear, and drag-to-pan
    const hitTarget = exportTarget.locator('svg path[data-arrow-hit-target="ENG-100->ENG-101"]');
    await expect(hitTarget).toBeAttached();

    // Real pointer click at the midpoint of the arrow's path, so the browser's own hit-testing
    // has to resolve the click through the stacked bars, rows and overlays to the arrow
    const clickArrowMidpoint = async () => {
      await hitTarget.scrollIntoViewIfNeeded();
      const point = await hitTarget.evaluate((el) => {
        const path = el as unknown as SVGPathElement;
        const mid = path.getPointAtLength(path.getTotalLength() / 2);
        const matrix = path.getScreenCTM()!;
        return { x: mid.x * matrix.a + matrix.e, y: mid.y * matrix.d + matrix.f };
      });
      await page.mouse.click(point.x, point.y);
    };
    await clickArrowMidpoint();

    await expect(arrow).toHaveAttribute('data-selected', 'true');
    const row100 = page.locator('tr[data-task-id="ENG-100"]');
    const row101 = page.locator('tr[data-task-id="ENG-101"]');
    const row102 = page.locator('tr[data-task-id="ENG-102"]');
    const bar100 = page.locator('[data-task-bar="ENG-100"]');
    const bar101 = page.locator('[data-task-bar="ENG-101"]');
    const bar102 = page.locator('[data-task-bar="ENG-102"]');

    await expect(row100).toHaveAttribute('data-highlighted', 'true');
    await expect(row101).toHaveAttribute('data-highlighted', 'true');
    await expect(bar100).toHaveAttribute('data-highlighted', 'true');
    await expect(bar101).toHaveAttribute('data-highlighted', 'true');
    await expect(row102).not.toHaveAttribute('data-highlighted', 'true');
    await expect(bar102).not.toHaveAttribute('data-highlighted', 'true');

    // IT-146: Highlighted bar's computed box-shadow renders the purple accent ring; unhighlighted bar does not
    await expect(bar100).toHaveCSS('box-shadow', /rgb\(124, 92, 252\) 0px 0px 0px 3px/);
    await expect(bar102).not.toHaveCSS('box-shadow', /rgba?\(124, 92, 252/);

    // Pressing Escape clears arrow selection and unhighlights issues
    await page.keyboard.press('Escape');
    await expect(arrow).not.toHaveAttribute('data-selected', 'true');
    await expect(row100).not.toHaveAttribute('data-highlighted', 'true');
    await expect(row101).not.toHaveAttribute('data-highlighted', 'true');
    await expect(bar100).not.toHaveCSS('box-shadow', /rgba?\(124, 92, 252/);

    // Clicking arrow again selects it; clicking empty timeline background clears selection
    await clickArrowMidpoint();
    await expect(arrow).toHaveAttribute('data-selected', 'true');
    await page
      .locator('[data-timeline-background]')
      .first()
      .click({ position: { x: 50, y: 10 } });
    await expect(arrow).not.toHaveAttribute('data-selected', 'true');
    await expect(row100).not.toHaveAttribute('data-highlighted', 'true');

    // Drag-to-pan on timeline background still works
    const initialScroll = await exportTarget.evaluate((el) => el.scrollLeft);
    const bg = page.locator('[data-timeline-background]').first();
    const bgBox = (await bg.boundingBox())!;
    await page.mouse.move(bgBox.x + 200, bgBox.y + 10);
    await page.mouse.down();
    await page.mouse.move(bgBox.x + 100, bgBox.y + 10, { steps: 5 });
    await page.mouse.up();
    const pannedScroll = await exportTarget.evaluate((el) => el.scrollLeft);
    expect(pannedScroll).toBeGreaterThan(initialScroll);

    // FilterBar fits cleanly within the 1280px viewport without horizontal clipping
    const filterBar = page.getByTestId('filter-bar');
    const barBox = await filterBar.boundingBox();
    expect(barBox).not.toBeNull();
    expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(1280);
    const lastButton = filterBar.getByRole('button').last();
    const lastButtonBox = await lastButton.boundingBox();
    expect(lastButtonBox).not.toBeNull();
    expect(lastButtonBox!.x + lastButtonBox!.width).toBeLessThanOrEqual(1280);

    // DetailPanel shows Completed (not overdue) for past-due completed tasks
    await doneBar.click();
    await expect(page.getByText('CAD completed early')).toBeVisible();
    await expect(page.getByText('(Completed)')).toBeVisible();
    await page.keyboard.press('Escape');

    // Completed toggle, inside the Filter dropdown, hides and restores completed tasks
    const filterButton = page.getByRole('button', { name: 'Filter', exact: true });
    await filterButton.click();
    const completedToggle = page.getByRole('button', { name: 'Completed', exact: true });
    await expect(completedToggle).toHaveAttribute('aria-pressed', 'true');
    await completedToggle.click();
    await expect(completedToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-task-bar="ENG-100"]')).toHaveCount(0);
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();
    await expect(
      page
        .locator('div')
        .filter({ hasText: /^0Completed$/ })
        .first(),
    ).toBeVisible();
    await expect(page.getByText('Completed hidden')).toBeVisible();

    // The Filter button surfaces the active filter count while the panel is open
    await expect(filterButton).toHaveAttribute('title', 'Filter tasks — 1 active');

    await completedToggle.click();
    await expect(page.locator('[data-task-bar="ENG-100"]')).toBeVisible();
    await expect(
      page
        .locator('div')
        .filter({ hasText: /^1Completed$/ })
        .first(),
    ).toBeVisible();
    await expect(page.getByText('Completed hidden')).toHaveCount(0);

    // Escape closes the panel and the bar no longer offers a grouping control
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: 'Filters' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'No grouping' })).toHaveCount(0);

    // Arrows still render with no grouping control left to suppress them
    await expect(exportTarget.locator('table')).toHaveCount(1);
    await expect(exportTarget.locator('tbody tr[data-task-id]')).toHaveCount(3);
    await expect(exportTarget.locator('svg path[marker-end="url(#dep-arrow)"]')).toHaveCount(1);

    expect(errors).toEqual([]);
  });

  test('colours task bars by schedule state rather than priority', async ({ page }) => {
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

    await page.route('**/api/history/baselines*', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            baselines: [
              {
                issue_id: 'ENG-303',
                planned_start: isoOffsetDays(-6),
                planned_due: isoOffsetDays(1),
              },
              {
                issue_id: 'ENG-301',
                planned_start: isoOffsetDays(-10),
                planned_due: isoOffsetDays(-4),
              },
            ],
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    // Priorities are deliberately mismatched with the states, so any priority colour would show
    const issue = (
      identifier: string,
      title: string,
      state: { name: string; type: string },
      startOffset: number | null,
      dueOffset: number,
      priority: number,
    ) => ({
      id: `uuid-${identifier}`,
      identifier,
      title,
      description: startOffset === null ? title : `${startTagOffsetDays(startOffset)}\n${title}`,
      dueDate: isoOffsetDays(dueOffset),
      url: `https://linear.app/bluecoreenergy/issue/${identifier}`,
      priority,
      state,
      createdAt: '2026-01-01T00:00:00Z',
      completedAt: state.type === 'completed' ? '2026-01-05T12:00:00Z' : null,
      assignee: { name: 'Andrew Phillips' },
      team: { id: 'team-1' },
      projectMilestone: null,
    });

    const started = { name: 'In Progress', type: 'started' };
    const todo = { name: 'Todo', type: 'unstarted' };

    await page.route('**/api/linear/graphql', async (route) => {
      const payload = route.request().postDataJSON() as { query?: string } | null;
      const query = payload?.query ?? '';
      if (await defaultScheduleMock.handle(route, payload)) return;
      const reply = (data: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });

      if (query.includes('projects(')) return reply({ projects: { nodes: [{ id: 'proj-1', name: 'State Colours' }] } });
      if (query.includes('externalLinks')) {
        return reply({
          project: { url: 'https://linear.app/bluecoreenergy/project/demo', externalLinks: { nodes: [] } },
        });
      }
      if (query.includes('project(id:')) {
        return reply({
          project: {
            name: 'State Colours',
            startDate: isoOffsetDays(-14),
            targetDate: isoOffsetDays(20),
            projectMilestones: { nodes: [] },
            issues: {
              nodes: [
                issue('ENG-301', 'Overdue while in progress', started, -6, -2, 4),
                issue('ENG-302', 'Being worked on', started, -1, 5, 1),
                issue('ENG-303', 'Should have started', todo, -3, 4, 1),
                issue('ENG-304', 'No start date', todo, null, 6, 1),
                issue('ENG-305', 'Starts later', todo, 2, 8, 1),
              ],
            },
            doneIssues: {
              nodes: [issue('ENG-300', 'Finished late', { name: 'Done', type: 'completed' }, -10, -4, 1)],
            },
          },
        });
      }
      if (query.includes('relations')) return reply({ issues: { nodes: [] } });
      if (query.includes('workflowStates')) {
        return reply({
          workflowStates: {
            nodes: [
              { id: 'st-1', name: 'Todo', type: 'unstarted', position: 0 },
              { id: 'st-2', name: 'In Progress', type: 'started', position: 1 },
              { id: 'st-3', name: 'Done', type: 'completed', position: 2 },
            ],
          },
        });
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');

    const bar = (id: string) => page.locator(`[data-task-bar="${id}"]`);
    await expect(bar('ENG-300')).toBeVisible();

    // Done wins over a missed due date; overdue wins over being in progress
    await expect(bar('ENG-300')).toHaveClass(/\bbar-done\b/);
    expect(await bar('ENG-300').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('rgb(34, 197, 94)');
    await expect(bar('ENG-301')).toHaveClass(/\bbar-overdue\b/);
    await expect(bar('ENG-302')).toHaveClass(/\bbar-in-progress\b/);
    await expect(bar('ENG-303')).toHaveClass(/\bbar-late-start\b/);
    // No start date is never "late to start", and a start date still ahead is simply not started
    await expect(bar('ENG-304')).toHaveClass(/\bbar-not-started\b/);
    await expect(bar('ENG-305')).toHaveClass(/\bbar-not-started\b/);

    // Red no longer pulses now that it is the only "late" signal
    await expect(bar('ENG-301')).toHaveCSS('animation-name', 'none');

    // ENG-301 is Low priority (formerly green) now rendering red, while
    // ENG-302..ENG-304 are Urgent rendering blue/amber/grey, so priority is not what the bar says
    const backgrounds = await page.evaluate(() =>
      ['ENG-301', 'ENG-302', 'ENG-303', 'ENG-304'].map(
        (id) => getComputedStyle(document.querySelector(`[data-task-bar="${id}"]`)!).backgroundImage,
      ),
    );
    expect(backgrounds[0]).toContain('rgb(239, 68, 68)'); // overdue red
    expect(backgrounds[1]).toContain('rgb(59, 130, 246)'); // in-progress blue
    expect(backgrounds[2]).toContain('rgb(245, 158, 11)'); // late-start amber
    expect(backgrounds[3]).toContain('rgb(161, 161, 170)'); // not-started grey
    expect(new Set(backgrounds).size).toBe(4);
    // ...and the in-progress blue stays clear of the accent purple used for selection
    expect(backgrounds[1]).not.toContain('rgb(124, 92, 252)');

    // Baseline ghost overlay: visible over the amber late-start bar (ENG-303) and overdue red bar (ENG-301)
    const ghostAmber = page.locator('[data-baseline-bar="ENG-303"]');
    const ghostRed = page.locator('[data-baseline-bar="ENG-301"]');
    await expect(ghostAmber).toBeVisible();
    await expect(ghostAmber).toHaveClass(/\bbaseline-ghost-bar\b/);
    await expect(ghostRed).toBeVisible();
    await expect(ghostRed).toHaveClass(/\bbaseline-ghost-bar\b/);

    const darkGhostStyle = await ghostAmber.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        borderStyle: s.borderStyle,
        borderColor: s.borderColor,
        borderWidth: s.borderWidth,
        filter: s.filter,
      };
    });
    expect(darkGhostStyle.borderStyle).toBe('dashed');
    expect(darkGhostStyle.borderWidth).toBe('2px');
    // Dark theme: crisp neutral border (text-primary #fafafa) and dark contrast halo
    expect(darkGhostStyle.borderColor).toBe('rgb(250, 250, 250)');
    expect(darkGhostStyle.filter).toContain('rgba(0, 0, 0');

    // In light theme, the ghost border inverts to dark neutral (#09090b) and halo to light
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
    });
    const lightGhostStyle = await ghostAmber.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        borderColor: s.borderColor,
        filter: s.filter,
      };
    });
    expect(lightGhostStyle.borderColor).toBe('rgb(9, 9, 11)');
    expect(lightGhostStyle.filter).toContain('rgba(255, 255, 255');

    expect(errors).toEqual([]);
  });

  test('renders overdue tasks ending verbatim on their due date without extending to today', async ({ page }) => {
    const errors = trackErrors(page);
    const mutations: string[] = [];

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
          body: JSON.stringify({ data: { projects: { nodes: [{ id: 'proj-1', name: 'Demo Project' }] } } }),
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
                startDate: isoOffsetDays(-15),
                targetDate: isoOffsetDays(10),
                projectMilestones: { nodes: [] },
                issues: {
                  nodes: [
                    {
                      id: 'uuid-overdue-start',
                      identifier: 'ENG-201',
                      title: 'Overdue with start date',
                      description: `${startTagOffsetDays(-12)}\nStarted 12 days ago`,
                      dueDate: isoOffsetDays(-6),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-201',
                      priority: 2,
                      state: { name: 'In Progress', type: 'started' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Andrew Phillips' },
                      team: { id: 'team-1' },
                      projectMilestone: null,
                    },
                    {
                      id: 'uuid-overdue-nostart',
                      identifier: 'ENG-202',
                      title: 'Overdue without start date',
                      description: 'No start tag',
                      dueDate: isoOffsetDays(-5),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-202',
                      priority: 3,
                      state: { name: 'Todo', type: 'unstarted' },
                      createdAt: '2026-01-01T00:00:00Z',
                      completedAt: null,
                      assignee: { name: 'Nate Jones' },
                      team: { id: 'team-1' },
                      projectMilestone: null,
                    },
                    {
                      id: 'uuid-future',
                      identifier: 'ENG-203',
                      title: 'On-time future task',
                      description: `${startTagOffsetDays(-2)}\nActive task`,
                      dueDate: isoOffsetDays(3),
                      url: 'https://linear.app/bluecoreenergy/issue/ENG-203',
                      priority: 3,
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
            data: { workflowStates: { nodes: [{ id: 'st-1', name: 'In Progress', type: 'started', position: 0 }] } },
          }),
        });
        return;
      }

      if (query.includes('issueUpdate')) {
        mutations.push(query);
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

    const bar201 = page.locator('[data-task-bar="ENG-201"]');
    const bar202 = page.locator('[data-task-bar="ENG-202"]');
    const bar203 = page.locator('[data-task-bar="ENG-203"]');
    await expect(bar201).toBeVisible();
    await expect(bar202).toBeVisible();
    await expect(bar203).toBeVisible();

    // Zero automatic due-date mutations on load
    expect(mutations).toEqual([]);

    // ENG-201 (-12d -> -6d, 7 days * 28px = 196px) and ENG-202 (due -5d, 2 days * 28px = 56px)
    // must end strictly on their due dates (5–6 days BEFORE today), not stretched to today.
    const box201 = await bar201.boundingBox();
    const box202 = await bar202.boundingBox();
    const box203 = await bar203.boundingBox();
    expect(box201).not.toBeNull();
    expect(box202).not.toBeNull();
    expect(box203).not.toBeNull();

    // ENG-201 spans 7 days (-12d..-6d -> 196px)
    expect(Math.round(box201!.width)).toBe(196);
    // ENG-202 spans 2 days (-6d..-5d -> 56px) and ends 1 day (28px) after ENG-201
    expect(Math.round(box202!.width)).toBe(56);
    expect(Math.round(box202!.x + box202!.width - (box201!.x + box201!.width))).toBe(28);
    // ENG-203 (-2d..+3d) ends 8 days (224px) after ENG-202 (-5d)
    expect(Math.round(box203!.x + box203!.width - (box202!.x + box202!.width))).toBe(224);

    // Overdue bars keep overdue visual status + verbatim due date in DetailPanel
    await expect(bar201).toHaveClass(/\bbar-overdue\b/);
    await bar201.click();
    await expect(page.getByText('6d overdue')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('shows configurable schedule columns with assignee and status by default', async ({ page }) => {
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

    const headers = page.locator('#gantt-export-target thead th');
    const headerLabels = async () => (await headers.allInnerTexts()).slice(0, -1).map((t) => t.split('\n')[0]);

    // Default columns: ID, issue, assignee, status, due date — priority is no longer shown
    expect(await headerLabels()).toEqual(['ID', 'ISSUE', 'ASSIGNEE', 'STATUS', 'DUE']);

    // The ID column leads the row and holds the issue ID
    await expect(page.locator('tr[data-task-id="ENG-101"] td').nth(0)).toContainText('ENG-101');

    // Assignee and status are real columns, not just icons in the task cell
    const assigneeCell = page.locator('tr[data-task-id="ENG-101"] td').nth(2);
    await expect(assigneeCell).toContainText('Andrew Phillips');
    const statusCell = page.locator('tr[data-task-id="ENG-101"] td').nth(3);
    await expect(statusCell).toContainText('In Progress');
    await expect(statusCell.locator('[data-status-bubble="ENG-101"]')).toBeVisible();

    // Right-clicking a header opens the picker, as does its header button
    await headers.nth(1).click({ button: 'right' });
    const picker = page.getByRole('group', { name: 'Columns' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('checkbox', { name: 'Issue', exact: true })).toBeDisabled();
    await expect(picker.getByRole('checkbox', { name: 'Issue', exact: true })).toBeChecked();
    await expect(picker.getByRole('checkbox', { name: 'Issue ID' })).toBeChecked();
    // ID is listed ahead of Issue, matching the table order
    const pickerLabels = await picker
      .getByRole('checkbox')
      .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).closest('label')?.textContent?.trim()));
    expect(pickerLabels.indexOf('Issue ID')).toBeLessThan(pickerLabels.indexOf('Issue'));
    // The menu is wider than the ID header it hangs from, so it must paint over the Issue header
    // beside it: sample the top-right corner of the menu, which overhangs that header
    const menuBox = (await picker.boundingBox())!;
    const topRightHit = await picker.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.right - 6, r.top + 4);
      return !!hit && el.contains(hit);
    });
    const issueHeaderBox = (await headers.nth(1).boundingBox())!;
    expect(menuBox.x + menuBox.width).toBeGreaterThan(issueHeaderBox.x + 20);
    expect(menuBox.y).toBeLessThan(issueHeaderBox.y + issueHeaderBox.height);
    expect(topRightHit).toBe(true);
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);

    const pickerButton = page.getByRole('button', { name: 'Choose columns' });
    await pickerButton.click();
    await expect(picker).toBeVisible();

    // Every optional column can be shown, and lands in the canonical order
    for (const label of ['Start date', 'Priority', 'Project', 'Sub-issue progress']) {
      await picker.getByRole('checkbox', { name: label }).check();
    }
    expect(await headerLabels()).toEqual([
      'ID',
      'ISSUE',
      'ASSIGNEE',
      'STATUS',
      'START',
      'DUE',
      'PRIORITY',
      'PROJECT',
      'SUB-ISSUES',
    ]);
    await expect(page.locator('tr[data-task-id="ENG-101"]')).toContainText('Demo Project');
    await expect(page.locator('tr[data-task-id="ENG-101"] td').nth(0)).toContainText('ENG-101');

    // ...and hidden again
    await picker.getByRole('checkbox', { name: 'Assignee' }).uncheck();
    expect(await headerLabels()).not.toContain('ASSIGNEE');
    await picker.getByRole('checkbox', { name: 'Assignee' }).check();

    // Hiding the status column keeps the status dropdown reachable in the task cell
    await picker.getByRole('checkbox', { name: 'Status' }).uncheck();
    expect(await headerLabels()).not.toContain('STATUS');
    await expect(page.locator('button[data-status-bubble="ENG-101"]')).toBeVisible();
    await picker.getByRole('checkbox', { name: 'Status' }).check();

    // The last optional column can't be hidden: that would leave only the issue column
    for (const label of ['Assignee', 'Status', 'Start date', 'Due date', 'Priority', 'Project', 'Sub-issue progress']) {
      await picker.getByRole('checkbox', { name: label }).uncheck();
    }
    expect(await headerLabels()).toEqual(['ID', 'ISSUE']);
    await expect(picker.getByRole('checkbox', { name: 'Issue ID' })).toBeDisabled();
    await picker.getByRole('checkbox', { name: 'Due date' }).check();
    await expect(picker.getByRole('checkbox', { name: 'Issue ID' })).toBeEnabled();

    // Back to a full set for the resize and reload checks below
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    for (const label of ['Start date', 'Priority', 'Project', 'Sub-issue progress']) {
      await picker.getByRole('checkbox', { name: label }).check();
    }
    await page.keyboard.press('Escape');

    // Resizing works for a column that isn't shown by default
    const statusHeader = headers.nth(3);
    const before = (await statusHeader.boundingBox())!;
    await page.mouse.move(before.x + before.width - 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width + 60, before.y + before.height / 2, { steps: 8 });
    await page.mouse.up();
    const after = (await statusHeader.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 40);

    // The selection and widths survive a reload
    await page.reload();
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();
    expect(await headerLabels()).toEqual([
      'ID',
      'ISSUE',
      'ASSIGNEE',
      'STATUS',
      'START',
      'DUE',
      'PRIORITY',
      'PROJECT',
      'SUB-ISSUES',
    ]);
    expect((await headers.nth(3).boundingBox())!.width).toBeCloseTo(after.width, 0);

    // Reset puts the defaults back
    await page.getByRole('button', { name: 'Choose columns' }).click();
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    expect(await headerLabels()).toEqual(['ID', 'ISSUE', 'ASSIGNEE', 'STATUS', 'DUE']);

    expect(errors).toEqual([]);
  });

  test('freezes visible schedule columns on desktop and only ID and Issue on mobile during horizontal scroll', async ({
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
                targetDate: isoOffsetDays(90),
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
                      title: 'Commissioning phase',
                      description: `${startTagOffsetDays(40)}\nCommissioning`,
                      dueDate: isoOffsetDays(60),
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
          body: JSON.stringify({ data: { issues: { nodes: [] } } }),
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

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/app');
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();

    // 1. On desktop, all visible schedule columns (id, task, assignee, status, due) are frozen
    for (const col of ['id', 'task', 'assignee', 'status', 'due']) {
      await expect(page.locator(`th[data-column-key="${col}"]`)).toHaveAttribute('data-frozen', 'true');
      await expect(page.locator(`tr[data-task-id="ENG-101"] td[data-column-key="${col}"]`)).toHaveAttribute(
        'data-frozen',
        'true',
      );
    }

    // Sticky body cells must have an opaque background so timeline elements do not bleed through
    const cellBg = await page
      .locator('tr[data-task-id="ENG-101"] td[data-column-key="task"]')
      .evaluate((el) => window.getComputedStyle(el).backgroundColor);
    expect(cellBg).toMatch(/^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/);

    // Z-index hierarchy: headers are higher than sticky body cells, which are higher than timeline bars/arrows
    const headerZIndex = await page
      .locator('th[data-column-key="task"]')
      .evaluate((el) => window.getComputedStyle(el).zIndex);
    const cellZIndex = await page
      .locator('tr[data-task-id="ENG-101"] td[data-column-key="task"]')
      .evaluate((el) => window.getComputedStyle(el).zIndex);
    expect(Number(headerZIndex)).toBe(10);
    expect(Number(cellZIndex)).toBe(6);
    expect(Number(headerZIndex)).toBeGreaterThan(Number(cellZIndex));
    expect(Number(cellZIndex)).toBeGreaterThanOrEqual(3);

    const scrollContainer = page.locator('#gantt-export-target');

    // Record pre-scroll bounding boxes on desktop
    const taskHeaderBefore = (await page.locator('th[data-column-key="task"]').boundingBox())!;
    const assigneeHeaderBefore = (await page.locator('th[data-column-key="assignee"]').boundingBox())!;
    const statusHeaderBefore = (await page.locator('th[data-column-key="status"]').boundingBox())!;
    const dueHeaderBefore = (await page.locator('th[data-column-key="due"]').boundingBox())!;
    const taskCellBefore = (await page.locator('tr[data-task-id="ENG-101"] td[data-column-key="task"]').boundingBox())!;
    const barBefore = (await page.locator('[data-task-bar="ENG-101"]').boundingBox())!;

    // Scroll horizontally by 250px
    await scrollContainer.evaluate((el) => {
      el.scrollLeft = 250;
    });
    await expect.poll(async () => scrollContainer.evaluate((el) => el.scrollLeft)).toBe(250);

    // Verify all frozen schedule column headers and cells stay pinned at their exact offsets
    const taskHeaderAfter = (await page.locator('th[data-column-key="task"]').boundingBox())!;
    const assigneeHeaderAfter = (await page.locator('th[data-column-key="assignee"]').boundingBox())!;
    const statusHeaderAfter = (await page.locator('th[data-column-key="status"]').boundingBox())!;
    const dueHeaderAfter = (await page.locator('th[data-column-key="due"]').boundingBox())!;
    const taskCellAfter = (await page.locator('tr[data-task-id="ENG-101"] td[data-column-key="task"]').boundingBox())!;
    const barAfter = (await page.locator('[data-task-bar="ENG-101"]').boundingBox())!;

    expect(taskHeaderAfter.x).toBeCloseTo(taskHeaderBefore.x, 1);
    expect(assigneeHeaderAfter.x).toBeCloseTo(assigneeHeaderBefore.x, 1);
    expect(statusHeaderAfter.x).toBeCloseTo(statusHeaderBefore.x, 1);
    expect(dueHeaderAfter.x).toBeCloseTo(dueHeaderBefore.x, 1);
    expect(taskCellAfter.x).toBeCloseTo(taskCellBefore.x, 1);

    // Timeline bar must have scrolled left
    expect(barAfter.x).toBeCloseTo(barBefore.x - 250, 1);

    // 2. Between the breakpoint and a roomy desktop, the frozen set would crowd the timeline,
    // so only ID and Issue stay pinned, side by side
    await scrollContainer.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(page.locator('th[data-column-key="id"]')).toHaveAttribute('data-frozen', 'true');
    await expect(page.locator('th[data-column-key="task"]')).toHaveAttribute('data-frozen', 'true');
    await expect(page.locator('th[data-column-key="assignee"]')).not.toHaveAttribute('data-frozen');
    const idMidBox = (await page.locator('th[data-column-key="id"]').boundingBox())!;
    const taskMidBox = (await page.locator('th[data-column-key="task"]').boundingBox())!;
    expect(taskMidBox.x).toBeCloseTo(idMidBox.x + idMidBox.width, 1);

    // 3. Below the 768px breakpoint only ID and Issue render, slimmed so both fit beside the timeline
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.locator('#gantt-export-target thead th[data-column-key]')).toHaveCount(2);
    await expect(page.locator('tr[data-task-id="ENG-101"] td[data-column-key]')).toHaveCount(2);
    for (const col of ['assignee', 'status', 'due']) {
      await expect(page.locator(`th[data-column-key="${col}"]`)).toHaveCount(0);
      await expect(page.locator(`tr[data-task-id="ENG-101"] td[data-column-key="${col}"]`)).toHaveCount(0);
    }
    await expect(page.locator('th[data-column-key="id"]')).toHaveAttribute('data-frozen', 'true');
    await expect(page.locator('th[data-column-key="task"]')).toHaveAttribute('data-frozen', 'true');
    // ID has its own column, so the Issue cell does not repeat it; status, now column-less, shows inline
    const mobileRow = page.locator('tr[data-task-id="ENG-101"]');
    await expect(mobileRow.locator('td[data-column-key="id"]')).toContainText('ENG-101');
    await expect(mobileRow.locator('td[data-column-key="task"] a')).toHaveCount(0);
    await expect(mobileRow.locator('td[data-column-key="task"] [data-status-bubble="ENG-101"]')).toBeVisible();

    const containerBox = (await scrollContainer.boundingBox())!;
    const idMobileBefore = (await page.locator('th[data-column-key="id"]').boundingBox())!;
    const taskMobileBefore = (await page.locator('th[data-column-key="task"]').boundingBox())!;
    expect(idMobileBefore.x).toBeCloseTo(containerBox.x, 1);
    expect(idMobileBefore.width).toBeCloseTo(80, 0);
    expect(taskMobileBefore.x).toBeCloseTo(idMobileBefore.x + idMobileBefore.width, 1);
    expect(taskMobileBefore.width).toBeCloseTo(200, 0);
    // Both pinned columns sit fully inside the viewport, with room left for the timeline
    expect(taskMobileBefore.x + taskMobileBefore.width).toBeLessThanOrEqual(containerBox.x + containerBox.width - 80);

    // The row's accent border sits on the leftmost cell, which is now ID
    await expect(mobileRow.locator('td[data-column-key="id"]')).toHaveCSS('border-left-width', '2px');
    await expect(mobileRow.locator('td[data-column-key="task"]')).toHaveCSS('border-left-width', '0px');

    // The timeline starts right after the pinned pair and is already in view
    const timelineBox = (await mobileRow.locator('[data-timeline-background]').boundingBox())!;
    expect(timelineBox.x).toBeCloseTo(taskMobileBefore.x + taskMobileBefore.width, 0);
    const probeX = timelineBox.x + 30;
    const probeInTimeline = await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-timeline-background]'),
      { x: probeX, y: timelineBox.y + timelineBox.height / 2 },
    );
    expect(probeInTimeline).toBe(true);

    // The picker explains the restriction once, and its checkboxes can't be changed from here
    await page.getByRole('button', { name: 'Choose columns' }).click();
    const narrowPicker = page.getByRole('group', { name: 'Columns' });
    await expect(narrowPicker).toContainText('Only ID and Issue are shown on narrow screens');
    await expect(narrowPicker.getByRole('checkbox', { name: 'Assignee' })).toBeChecked();
    for (const label of ['Issue ID', 'Assignee', 'Status', 'Due date', 'Priority']) {
      await expect(narrowPicker.getByRole('checkbox', { name: label })).toBeDisabled();
    }
    await page.keyboard.press('Escape');
    await expect(narrowPicker).toHaveCount(0);

    // Scrolling reaches further into the timeline while ID and Issue stay pinned, with Issue still beside ID
    await scrollContainer.evaluate((el) => {
      el.scrollLeft = 180;
    });
    await expect.poll(async () => scrollContainer.evaluate((el) => el.scrollLeft)).toBe(180);
    const idMobileAfter = (await page.locator('th[data-column-key="id"]').boundingBox())!;
    const taskMobileAfter = (await page.locator('th[data-column-key="task"]').boundingBox())!;
    const timelineAfter = (await mobileRow.locator('[data-timeline-background]').boundingBox())!;
    expect(idMobileAfter.x).toBeCloseTo(idMobileBefore.x, 1);
    expect(taskMobileAfter.x).toBeCloseTo(taskMobileBefore.x, 1);
    expect(timelineAfter.x).toBeCloseTo(timelineBox.x - 180, 1);
    const coveredByTask = await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('td[data-column-key="task"]'),
      { x: taskMobileAfter.x + taskMobileAfter.width - 10, y: timelineBox.y + timelineBox.height / 2 },
    );
    expect(coveredByTask).toBe(true);

    // 4. Narrow display is not a saved change: widening restores the full set and storage is untouched
    expect(await page.evaluate(() => localStorage.getItem('gantt_columns'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('gantt_column_widths'))).toBeNull();
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const col of ['id', 'task', 'assignee', 'status', 'due']) {
      await expect(page.locator(`th[data-column-key="${col}"]`)).toHaveAttribute('data-frozen', 'true');
    }
    expect((await page.locator('th[data-column-key="task"]').boundingBox())!.width).toBeCloseTo(300, 0);
    expect(await page.evaluate(() => localStorage.getItem('gantt_columns'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('gantt_column_widths'))).toBeNull();

    expect(errors).toEqual([]);
  });

  test('keeps the status dot and warning icon inside the narrow Issue cell at the deepest indent', async ({ page }) => {
    const errors = trackErrors(page);
    const stateUpdates: string[] = [];

    await page.addInitScript(() => {
      localStorage.setItem('gantt_onboarding_done', '1');
      localStorage.setItem('gantt_theme', 'dark');
      localStorage.setItem('linear_selected_project', 'proj-1');
    });
    await page.route('**/api/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'dev@bluecore.energy', linearConnected: true }),
      }),
    );

    const issue = (n: number, title: string, dueInDays: number, startInDays: number, parent: number | null) => ({
      id: `uuid-${n}`,
      identifier: `LOC-${n}`,
      title,
      description: `${startTagOffsetDays(startInDays)}\nDetails`,
      dueDate: isoOffsetDays(dueInDays),
      url: `https://linear.app/bluecoreenergy/issue/LOC-${n}`,
      priority: 2,
      state: { name: 'Todo', type: 'unstarted' },
      createdAt: '2026-01-01T00:00:00Z',
      completedAt: null,
      canceledAt: null,
      assignee: { name: 'Andrew Phillips' },
      team: { id: 'team-1' },
      projectMilestone: null,
      parent: parent === null ? null : { id: `uuid-${parent}`, identifier: `LOC-${parent}` },
    });
    const childRef = (n: number) => ({
      id: `uuid-${n}`,
      completedAt: null,
      state: { name: 'Todo', type: 'unstarted' },
    });
    // Both ends of the longest-named project badge: a long project name makes the external badge as wide as it can get
    const externalIssue = {
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
      project: { id: 'proj-2', name: 'Controls and Instrumentation Rollout', targetDate: isoOffsetDays(20) },
    };

    // A two-letter title beside that same long project name: the title's natural width is tiny
    const shortExternalIssue = { ...externalIssue, id: 'uuid-ctrl-43', identifier: 'CTRL-43', title: 'QA' };

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
        return respond({
          projects: {
            nodes: [
              { id: 'proj-1', name: 'Local' },
              { id: 'proj-2', name: 'Controls and Instrumentation Rollout' },
            ],
          },
        });
      }
      if (query.includes('externalLinks')) {
        return respond({
          project: { url: 'https://linear.app/bluecoreenergy/project/demo', externalLinks: { nodes: [] } },
        });
      }
      if (query.includes('project(id:')) {
        return respond({
          project: {
            name: 'Local',
            startDate: isoOffsetDays(-5),
            targetDate: isoOffsetDays(40),
            projectMilestones: { nodes: [] },
            issues: {
              nodes: [
                issue(300, 'Root', 20, -4, null),
                issue(301, 'Depth one', 18, -3, 300),
                issue(302, 'Depth two', 16, -3, 301),
                issue(303, 'Depth three with a long enough title to truncate', 14, -2, 302),
                issue(304, 'Depth four with a long enough title to truncate', 13, -2, 303),
                issue(305, 'Depth five with a long enough title to truncate', 12, -2, 304),
                issue(306, 'Depth five with a warning and a long title to truncate', 11, -2, 304),
                issue(307, 'Depth six with a long enough title to truncate', 10, -2, 305),
                issue(308, 'Depth seven with a warning and a long title to truncate', 9, -2, 307),
                issue(310, 'Blocker due late', 25, -4, null),
              ],
            },
            doneIssues: { nodes: [] },
          },
        });
      }
      if (query.includes('relations')) {
        const relationsOf = (n: number, nodes: unknown[], children: number[]) => ({
          id: `uuid-${n}`,
          identifier: `LOC-${n}`,
          relations: { nodes },
          children: { nodes: children.map(childRef) },
        });
        return respond({
          issues: {
            nodes: [
              relationsOf(300, [], [301]),
              relationsOf(301, [], [302]),
              relationsOf(302, [], [303]),
              // LOC-303 and the external CTRL-42 both start before LOC-310 is due, so both carry a warning
              relationsOf(303, [{ type: 'blocked_by', relatedIssue: { identifier: 'LOC-310' } }], [304]),
              // LOC-304 also warns (depth four with a warning); LOC-305 leads into deeper hierarchy
              relationsOf(304, [{ type: 'blocked_by', relatedIssue: { identifier: 'LOC-310' } }], [305, 306]),
              relationsOf(305, [], [307]),
              // LOC-306 is a depth-five sibling that also warns
              relationsOf(306, [{ type: 'blocked_by', relatedIssue: { identifier: 'LOC-310' } }], []),
              relationsOf(307, [], [308]),
              // LOC-308 is depth seven and warns, testing deep indentation fit and status menu reachability
              relationsOf(308, [{ type: 'blocked_by', relatedIssue: { identifier: 'LOC-310' } }], []),
              relationsOf(
                310,
                [
                  { type: 'blocks', relatedIssue: { identifier: 'LOC-303' } },
                  { type: 'blocks', relatedIssue: { identifier: 'LOC-304' } },
                  { type: 'blocks', relatedIssue: { identifier: 'LOC-306' } },
                  { type: 'blocks', relatedIssue: { identifier: 'LOC-308' } },
                  { type: 'blocks', relatedIssue: externalIssue },
                  { type: 'blocks', relatedIssue: shortExternalIssue },
                ],
                [],
              ),
            ],
          },
        });
      }
      if (query.includes('workflowStates')) {
        return respond({
          workflowStates: {
            nodes: [
              { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 },
              { id: 'st-prog', name: 'In Progress', type: 'started', position: 1 },
              { id: 'st-done', name: 'Done', type: 'completed', position: 2 },
            ],
          },
        });
      }
      if (query.includes('issueUpdate')) {
        stateUpdates.push(String(payload?.variables?.id ?? ''));
        return respond({ issueUpdate: { success: true } });
      }
      return route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/app');
    await expect(page.locator('tr[data-task-id="LOC-303"]')).toBeVisible();
    await expect(page.locator('tr[data-task-id="LOC-303"]')).toHaveAttribute('data-task-depth', '3');
    await expect(page.locator('tr[data-task-id="CTRL-42"]')).toHaveAttribute('data-external-task', 'true');

    await expect(page.locator('tr[data-task-id="LOC-304"]')).toHaveAttribute('data-task-depth', '4');
    await expect(page.locator('tr[data-task-id="LOC-305"]')).toHaveAttribute('data-task-depth', '5');
    await expect(page.locator('tr[data-task-id="LOC-307"]')).toHaveAttribute('data-task-depth', '6');
    await expect(page.locator('tr[data-task-id="LOC-308"]')).toHaveAttribute('data-task-depth', '7');

    // The widest lines the Issue cell can hold at 200px: deep indents (3 and 4 with a warning, 5 with just the
    // dot, which is the only status control on a phone, and depth 7 with a warning) and an external row (always top level)
    // with its project badge and a warning
    // `minTitle` is how much of the title must survive.
    for (const { id, warns, minTitle } of [
      { id: 'LOC-303', warns: true, minTitle: 16 },
      { id: 'LOC-304', warns: true, minTitle: 16 },
      { id: 'LOC-305', warns: false, minTitle: 16 },
      { id: 'LOC-306', warns: true, minTitle: 10 },
      { id: 'LOC-307', warns: false, minTitle: 16 },
      { id: 'LOC-308', warns: true, minTitle: 10 },
      { id: 'CTRL-42', warns: true, minTitle: 16 },
      { id: 'CTRL-43', warns: true, minTitle: 16 },
    ]) {
      const row = page.locator(`tr[data-task-id="${id}"]`);
      const cell = row.locator('td[data-column-key="task"]');
      await expect(cell.locator('span[title^="Starts before"]')).toHaveCount(warns ? 1 : 0);
      const bubble = cell.locator(`[data-status-bubble="${id}"]`);
      await expect(bubble).toBeVisible();

      const cellBox = (await cell.boundingBox())!;
      expect(cellBox.width).toBeCloseTo(200, 0);
      const metaRow = bubble.locator('xpath=..').locator('xpath=..');
      const fit = await metaRow.evaluate((el) => ({
        children: Array.from(el.children).map((c) => c.getBoundingClientRect().right),
        right: el.getBoundingClientRect().right,
      }));
      // Nothing in the metadata line spills past it, and the line stays within the cell. (The dot's 20px hit
      // area deliberately overhangs its 8px box into the cell padding, so scrollWidth is not a fair measure.)
      for (const childRight of fit.children) expect(childRight).toBeLessThanOrEqual(fit.right + 0.5);
      expect(fit.right).toBeLessThanOrEqual(cellBox.x + cellBox.width);

      // The status dot sits fully inside the cell, and is what a click there lands on
      const dotBox = (await bubble.boundingBox())!;
      expect(dotBox.x).toBeGreaterThanOrEqual(cellBox.x);
      expect(dotBox.x + dotBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width);
      const hit = await page.evaluate(
        ({ x, y, id: taskId }) => document.elementFromPoint(x, y)?.closest(`[data-status-bubble="${taskId}"]`) !== null,
        { x: dotBox.x + dotBox.width / 2, y: dotBox.y + dotBox.height / 2, id },
      );
      expect(hit).toBe(true);
      if (warns) {
        const warnBox = (await cell.locator('span[title^="Starts before"]').boundingBox())!;
        expect(warnBox.x + warnBox.width).toBeLessThanOrEqual(dotBox.x);
      }

      // The title keeps some room: it truncates rather than vanishing, even beside a long project badge
      const titleBox = (await cell.locator(`[data-task-title="${id}"]`).boundingBox())!;
      expect(titleBox.width).toBeGreaterThanOrEqual(minTitle);
      if (id === 'CTRL-43') {
        // A two-letter title beside the longest project name is shown whole: the badge is capped, so it can't starve it
        const truncated = await cell
          .locator(`[data-task-title="${id}"]`)
          .evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(truncated).toBe(false);
      }
      expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(dotBox.x);
    }

    // The Issue cell holds only the title and these indicators: no dependency icon or sub-issue count
    await expect(page.locator('tr[data-task-id="LOC-310"] td[data-column-key="task"] svg[aria-label]')).toHaveCount(0);
    await expect(page.locator('tr[data-task-id="LOC-300"] td[data-column-key="task"]')).not.toContainText(/\d\/\d/);

    // The external row shows its project badge alongside the warning and dot without being squeezed out
    const badgeBox = (await page
      .locator('tr[data-task-id="CTRL-42"] td[data-column-key="task"] [data-external-project-jump]')
      .boundingBox())!;
    expect(badgeBox.width).toBeGreaterThan(20);

    // Renaming hides the project badge, warning, and status dot so the input gets all available room,
    // and they return afterwards.
    const warning = (id: string) =>
      page.locator(`tr[data-task-id="${id}"] td[data-column-key="task"] span[title^="Starts before"]`);
    const renameWidths: Record<string, number> = {};
    for (const { id, minInput } of [
      { id: 'LOC-303', minInput: 90 },
      { id: 'LOC-304', minInput: 80 },
      { id: 'LOC-305', minInput: 70 },
      { id: 'LOC-306', minInput: 70 },
      { id: 'LOC-308', minInput: 60 },
    ]) {
      const hasWarning = id !== 'LOC-305';
      const cell = page.locator(`tr[data-task-id="${id}"] td[data-column-key="task"]`);
      const cellBox = (await cell.boundingBox())!;
      await expect(warning(id)).toHaveCount(hasWarning ? 1 : 0);
      await expect(page.locator(`[data-status-bubble="${id}"]`)).toBeVisible();

      // For LOC-308, open status menu first to verify starting a title edit closes any open menu
      if (id === 'LOC-308') {
        await page.locator(`[data-status-bubble="${id}"]`).click();
        await expect(page.locator(`[data-inline-menu="Status for ${id}"]`)).toBeVisible();
      }

      await page.locator(`[data-task-title="${id}"]`).dblclick();
      const input = page.locator('input[data-inline-edit="title"]');
      await expect(input).toBeFocused();

      if (id === 'LOC-308') {
        await expect(page.locator(`[data-inline-menu="Status for ${id}"]`)).toHaveCount(0);
      }

      await expect(warning(id)).toHaveCount(0);
      // Status dot is hidden during title rename so inline rename gets the remaining room (~60+px even at depth 7)
      await expect(page.locator(`[data-status-bubble="${id}"]`)).toHaveCount(0);
      const inputBox = (await input.boundingBox())!;
      expect(inputBox.width).toBeGreaterThanOrEqual(minInput);
      expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width);
      renameWidths[id] = inputBox.width;

      if (id === 'LOC-306') {
        // Exercise Enter save
        await input.fill('Depth five with warning renamed');
        await page.keyboard.press('Enter');
        await expect(input).toHaveCount(0);
        await expect(page.locator(`[data-task-title="${id}"]`)).toHaveText('Depth five with warning renamed');
      } else {
        await page.keyboard.press('Escape');
        await expect(input).toHaveCount(0);
      }

      await expect(warning(id)).toHaveCount(hasWarning ? 1 : 0);
      await expect(page.locator(`[data-status-bubble="${id}"]`)).toBeVisible();
    }
    // The warning costs a rename nothing: depth five with one gets the same width as depth five without
    expect(Math.abs(renameWidths['LOC-306'] - renameWidths['LOC-305'])).toBeLessThanOrEqual(1);

    // Saving LOC-306 dispatched an issue update
    await expect.poll(() => stateUpdates).toEqual(['uuid-306']);

    // Enabling external write mode unlocks inline editing for external rows
    const editExternalBtn = page.getByRole('button', { name: 'Edit external' });
    await editExternalBtn.click();
    await expect(page.getByRole('button', { name: 'Editing external' })).toHaveAttribute('aria-pressed', 'true');

    // Renaming an external row hides its project badge and status dot so the input gets the room
    const ctrlBadge = page.locator(
      'tr[data-task-id="CTRL-42"] td[data-column-key="task"] [data-external-project-jump]',
    );
    await expect(ctrlBadge).toBeVisible();
    await expect(page.locator('[data-status-bubble="CTRL-42"]')).toBeVisible();
    await page.locator('[data-task-title="CTRL-42"]').dblclick();
    const ctrlInput = page.locator('input[data-inline-edit="title"]');
    await expect(ctrlInput).toBeFocused();
    await expect(ctrlBadge).toHaveCount(0);
    await expect(page.locator('[data-status-bubble="CTRL-42"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(ctrlInput).toHaveCount(0);
    await expect(ctrlBadge).toBeVisible();
    await expect(page.locator('[data-status-bubble="CTRL-42"]')).toBeVisible();

    // Lock external editing again
    await page.getByRole('button', { name: 'Editing external' }).click();
    await expect(page.getByRole('button', { name: 'Edit external' })).toBeVisible();

    const dismissToasts = () => dismissToastsHelper(page);

    // Changing status via the dot menu works from the deepest rows
    await dismissToasts();
    await page.locator('[data-status-bubble="LOC-303"]').click();
    const menu303 = page.locator('[data-inline-menu="Status for LOC-303"]');
    await expect(menu303).toBeVisible();
    await menu303.getByRole('option', { name: 'In Progress' }).click();
    await expect.poll(() => stateUpdates).toEqual(['uuid-306', 'uuid-303']);
    await dismissToasts();
    await page.locator('[data-status-bubble="LOC-305"]').click();
    const menu305 = page.locator('[data-inline-menu="Status for LOC-305"]');
    await expect(menu305).toBeVisible();
    await menu305.getByRole('option', { name: 'Done' }).click();
    await expect.poll(() => stateUpdates).toEqual(['uuid-306', 'uuid-303', 'uuid-305']);
    // Deepest row (depth 7 with warning) opens status menu and updates status without toast obstruction
    await dismissToasts();
    await page.locator('[data-status-bubble="LOC-308"]').click();
    const menu308 = page.locator('[data-inline-menu="Status for LOC-308"]');
    await expect(menu308).toBeVisible();
    await menu308.getByRole('option', { name: 'In Progress' }).click();
    await expect.poll(() => stateUpdates).toEqual(['uuid-306', 'uuid-303', 'uuid-305', 'uuid-308']);

    expect(errors).toEqual([]);
  });
});
