import { expect, test, type Page } from '@playwright/test';

function localOffsetDate(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

function isoOffsetDays(days: number): string {
  const d = localOffsetDate(days);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function startTagOffsetDays(days: number): string {
  const d = localOffsetDate(days);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `start: ${dd}-${mm}-${yy}`;
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  const isLocal = (url: string) => url.startsWith('http://127.0.0.1:4173');
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('requestfailed', (req) => {
    if (isLocal(req.url())) {
      errors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`);
    }
  });
  page.on('response', (res) => {
    if (isLocal(res.url()) && res.status() >= 400) errors.push(`http ${res.status()}: ${res.url()}`);
  });
  return errors;
}

test.describe('GanttSmart GCP app', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://fonts.googleapis.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
    );
    await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
  });

  test('redirects / to /app, shows Connect Linear with GCP sign-out note, and blocks share route', async ({ page }) => {
    const errors = trackErrors(page);

    await page.goto('/');
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('heading', { name: 'Connect to Linear' })).toBeVisible();
    await expect(page.getByText('dev@bluecore.energy')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect Linear Account' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByText('Signs out of GanttSmart only, not Google.')).toBeVisible();

    await page.goto('/share/some-token');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    expect(errors).toEqual([]);
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

    // Account menu shows GCP Sign out + note and export actions
    await page.getByTitle('Account').click();
    await expect(page.getByRole('button', { name: 'Export as PNG' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export as PDF' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect Linear' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByText('Signs out of GanttSmart only, not Google.')).toBeVisible();
    await page.getByTitle('Account').click();

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
    await expect(page.getByText('1/2', { exact: true })).toBeVisible();
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

    // Theme toggle flips dark/light class on <html>
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.getByTitle('Account').click();
    await page.locator('button[title*="mode"]').click();
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);

    expect(errors).toEqual([]);
  });

  test('searches and selects a project in the project dropdown', async ({ page }) => {
    const errors = trackErrors(page);

    const projectsList = [
      { id: 'proj-1', name: 'Alpha Platform' },
      { id: 'proj-2', name: 'Beta Mobile' },
      { id: 'proj-3', name: 'Demo Project' },
      { id: 'proj-4', name: 'Telemetry Pipeline' },
      { id: 'proj-5', name: 'Valve Actuator' },
    ];

    const tasksByProject: Record<string, { name: string; id: string; title: string }> = {
      'proj-1': { name: 'Alpha Platform', id: 'ALP-401', title: 'Upgrade auth gateway' },
      'proj-3': { name: 'Demo Project', id: 'ENG-101', title: 'Design valve manifold' },
      'proj-4': { name: 'Telemetry Pipeline', id: 'TEL-201', title: 'Stream sensor metrics' },
      'proj-2': { name: 'Beta Mobile', id: 'MOB-301', title: 'Ship offline cache' },
      'proj-5': { name: 'Valve Actuator', id: 'VLV-501', title: 'Calibrate solenoid' },
    };

    await page.addInitScript(() => {
      localStorage.setItem('gantt_onboarding_done', '1');
      localStorage.setItem('gantt_theme', 'dark');
      localStorage.setItem('linear_selected_project', 'proj-3');
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
        variables?: { id?: string };
      } | null;
      const query = payload?.query ?? '';

      if (query.includes('projects(')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { projects: { nodes: projectsList } } }),
        });
        return;
      }

      if (query.includes('project(id:')) {
        const projectId = payload?.variables?.id ?? 'proj-3';
        const proj = tasksByProject[projectId] ?? tasksByProject['proj-3'];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              project: {
                name: proj.name,
                startDate: isoOffsetDays(-5),
                targetDate: isoOffsetDays(15),
                projectMilestones: { nodes: [] },
                issues: {
                  nodes: [
                    {
                      id: `uuid-${proj.id}`,
                      identifier: proj.id,
                      title: proj.title,
                      description: startTagOffsetDays(-1),
                      dueDate: isoOffsetDays(5),
                      url: `https://linear.app/bluecoreenergy/issue/${proj.id}`,
                      priority: 2,
                      state: { name: 'In Progress', type: 'started' },
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

    await page.goto('/app');
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();

    // Set a task search filter to verify Escape in project search doesn't clear task search
    const taskSearch = page.getByPlaceholder('Search tasks…');
    await taskSearch.fill('manifold');
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();

    // Open project dropdown — search input receives focus automatically
    const projectTrigger = page.getByRole('button', { name: 'Demo Project' });
    await projectTrigger.click();

    const projectSearch = page.getByPlaceholder('Search projects…');
    await expect(projectSearch).toBeVisible();
    await expect(projectSearch).toBeFocused();
    await expect(page.getByRole('option')).toHaveCount(5);

    // Non-matching query displays empty state
    await projectSearch.fill('zzz-unknown');
    await expect(page.getByText('No projects found')).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(0);

    // Clear button restores all options
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(projectSearch).toHaveValue('');
    await expect(page.getByRole('option')).toHaveCount(5);

    // Typing filters case-insensitively
    await projectSearch.fill('valve');
    await expect(page.getByRole('option')).toHaveCount(1);
    await expect(page.getByRole('option', { name: 'Valve Actuator' })).toBeVisible();

    // Escape closes the dropdown, returns focus to trigger, and preserves task search
    await page.keyboard.press('Escape');
    await expect(projectSearch).toHaveCount(0);
    await expect(projectTrigger).toBeFocused();
    await expect(taskSearch).toHaveValue('manifold');

    // Clear task search before switching projects
    await taskSearch.fill('');

    // Re-open, search, and select via Enter key
    await projectTrigger.click();
    await expect(projectSearch).toHaveValue('');
    await projectSearch.fill('telemetry');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');

    await expect(page.getByRole('button', { name: 'Telemetry Pipeline' })).toBeVisible();
    await expect(page.locator('[data-task-bar="TEL-201"]')).toBeVisible();

    // Re-open, filter, and select by clicking an option
    await page.getByRole('button', { name: 'Telemetry Pipeline' }).click();
    await expect(projectSearch).toHaveValue('');
    await projectSearch.fill('beta');
    await page.getByRole('option', { name: 'Beta Mobile' }).click();

    await expect(page.getByRole('button', { name: 'Beta Mobile' })).toBeVisible();
    await expect(page.locator('[data-task-bar="MOB-301"]')).toBeVisible();

    // Navigate filtered results with ArrowDown + Enter
    await page.getByRole('button', { name: 'Beta Mobile' }).click();
    await projectSearch.fill('a');
    // Matches: Alpha Platform, Beta Mobile, Valve Actuator -> initial highlight is Beta Mobile (selected);
    // ArrowDown moves to Valve Actuator
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('button', { name: 'Valve Actuator' })).toBeVisible();
    await expect(page.locator('[data-task-bar="VLV-501"]')).toBeVisible();

    // Tab from the search input closes the dropdown and moves focus to the next control (Filter)
    await page.getByRole('button', { name: 'Valve Actuator' }).click();
    await expect(projectSearch).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(projectSearch).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeFocused();

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

    // FilterBar count pill reflects only the 2 active scheduled tasks
    await expect(page.getByText('2/2', { exact: true })).toBeVisible();

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

    // StatsRow and FilterBar reflect unified counts (3/3 total, 1 completed)
    await expect(page.getByText('3/3')).toBeVisible();
    const completedStat = page
      .locator('div')
      .filter({ hasText: /^1Completed$/ })
      .first();
    await expect(completedStat).toBeVisible();

    // Dependency arrow renders between completed blocker ENG-100 and active ENG-101
    const arrow = exportTarget.locator('svg path[marker-end="url(#dep-arrow)"]');
    await expect(arrow).toHaveCount(1);

    // ...routed with rounded elbows, and painted beneath the task bars
    await expect(arrow).toHaveAttribute('d', /^M[-\d\s.HVQ,]+$/);
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

    // Pressing Escape clears arrow selection and unhighlights issues
    await page.keyboard.press('Escape');
    await expect(arrow).not.toHaveAttribute('data-selected', 'true');
    await expect(row100).not.toHaveAttribute('data-highlighted', 'true');
    await expect(row101).not.toHaveAttribute('data-highlighted', 'true');

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
    const countBox = await page.getByText('3/3').boundingBox();
    expect(countBox).not.toBeNull();
    expect(countBox!.x + countBox!.width).toBeLessThanOrEqual(1280);

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
    await expect(page.getByText('2/3')).toBeVisible();
    await expect(page.getByText('Completed hidden')).toBeVisible();

    // The Filter button surfaces the active filter count while the panel is open
    await expect(filterButton).toHaveAttribute('title', 'Filter tasks — 1 active');

    await completedToggle.click();
    await expect(page.locator('[data-task-bar="ENG-100"]')).toBeVisible();
    await expect(page.getByText('3/3')).toBeVisible();

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

  test('submits Feature Request and Bug Report issues to Linear and stays accessible on mobile', async ({ page }) => {
    const errors = trackErrors(page);
    const createdInputs: Array<Record<string, unknown>> = [];

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
        variables?: { input?: Record<string, unknown> };
      } | null;
      const query = payload?.query ?? '';

      if (query.includes('FeedbackTarget')) {
        expect(query).not.toMatch(/\blabels\s*\(/);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              projects: {
                nodes: [
                  {
                    id: '0ac0d58d-1852-4d27-9fbc-944cabc5b492',
                    name: 'GanttSmart',
                    url: 'https://linear.app/bluecoreenergy/project/ganttsmart-5114378da6de',
                    slugId: '5114378da6de',
                    teams: {
                      nodes: [
                        {
                          id: '2e7232fc-d509-4471-9922-e5f8c89459d3',
                          key: 'IT',
                          name: 'IT',
                        },
                      ],
                    },
                  },
                ],
              },
              teams: { nodes: [] },
              issueLabels: {
                nodes: [
                  {
                    id: '6ef1fd41-af6d-48ec-ae08-2a529cfc0013',
                    name: 'Feature',
                    isGroup: false,
                    team: { id: '2e7232fc-d509-4471-9922-e5f8c89459d3' },
                  },
                  {
                    id: '79878471-e70d-405d-83b7-a50dd8a853fe',
                    name: 'Bug',
                    isGroup: false,
                    team: { id: '2e7232fc-d509-4471-9922-e5f8c89459d3' },
                  },
                ],
              },
            },
          }),
        });
        return;
      }

      if (query.includes('issueCreate')) {
        const input = payload?.variables?.input ?? {};
        createdInputs.push(input);
        const index = createdInputs.length;
        const identifier = `IT-${120 + index - 1}`;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: `issue-uuid-${index}`,
                  identifier,
                  title: String(input.title ?? ''),
                  url: `https://linear.app/bluecoreenergy/issue/${identifier}`,
                },
              },
            },
          }),
        });
        return;
      }

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
                startDate: isoOffsetDays(-5),
                targetDate: isoOffsetDays(15),
                projectMilestones: { nodes: [] },
                issues: {
                  nodes: [
                    {
                      id: 'uuid-1',
                      identifier: 'ENG-101',
                      title: 'Design valve manifold',
                      description: startTagOffsetDays(-2),
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
                nodes: [{ id: 'st-1', name: 'In Progress', type: 'started', position: 0 }],
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

    // Header fits in desktop viewport without wrapping
    const headerBox = await page.locator('header').boundingBox();
    expect(headerBox).not.toBeNull();
    expect(headerBox!.height).toBeLessThanOrEqual(54);

    // 1. Open Feedback modal
    await page.getByRole('button', { name: 'Feedback' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab', { name: 'Feature Request' })).toHaveAttribute('aria-selected', 'true');

    // Validation requires title
    await dialog.getByRole('button', { name: 'Submit Feature Request' }).click();
    await expect(dialog.getByText('Please enter a title.')).toBeVisible();

    // Fill structured Feature Request fields (including r/+/− keys to ensure shortcuts do not fire)
    await dialog.getByLabel(/Title/).fill('Export milestones + dates to CSV');
    await dialog.getByLabel('What are you trying to do?').fill('Share milestones with contractors');
    await dialog.getByLabel('What gets in the way?').fill('Only PNG/PDF export exists - hard to filter');
    await dialog.getByLabel('What would help?').fill('Add a CSV export option under Export');
    await dialog.getByRole('button', { name: 'Submit Feature Request' }).click();

    await expect(dialog.getByText('Feature request submitted')).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Open IT-120 in Linear ↗' })).toHaveAttribute(
      'href',
      'https://linear.app/bluecoreenergy/issue/IT-120',
    );
    await expect(page.getByText('Created IT-120 in Linear')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open IT-120 ↗' })).toHaveAttribute(
      'href',
      'https://linear.app/bluecoreenergy/issue/IT-120',
    );

    expect(createdInputs[0]).toEqual({
      teamId: '2e7232fc-d509-4471-9922-e5f8c89459d3',
      projectId: '0ac0d58d-1852-4d27-9fbc-944cabc5b492',
      title: 'Export milestones + dates to CSV',
      description: [
        '### What are you trying to do?\nShare milestones with contractors',
        '### What gets in the way?\nOnly PNG/PDF export exists - hard to filter',
        '### What would help?\nAdd a CSV export option under Export',
      ].join('\n\n'),
      labelIds: ['6ef1fd41-af6d-48ec-ae08-2a529cfc0013'],
    });

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);

    // 2. Open Feedback modal and switch to Bug Report tab
    await page.getByRole('button', { name: 'Feedback' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'Bug Report' }).click();
    await expect(dialog.getByRole('tab', { name: 'Bug Report' })).toHaveAttribute('aria-selected', 'true');

    await dialog.getByLabel(/Title/).fill('Zoom slider jumps on drag');
    await dialog.getByLabel('What happened?').fill('Timeline shifted after drag');
    await dialog.getByLabel('Steps to reproduce').fill('1. Drag bar\n2. Release outside column');
    await dialog.getByLabel('Expected behavior').fill('Bar stays on release day');
    await expect(dialog.getByLabel(/Include non-sensitive app context/)).toBeChecked();
    await dialog.getByRole('button', { name: 'Submit Bug Report' }).click();

    await expect(dialog.getByText('Bug report submitted')).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Open IT-121 in Linear ↗' })).toHaveAttribute(
      'href',
      'https://linear.app/bluecoreenergy/issue/IT-121',
    );

    expect(createdInputs[1]).toMatchObject({
      teamId: '2e7232fc-d509-4471-9922-e5f8c89459d3',
      projectId: '0ac0d58d-1852-4d27-9fbc-944cabc5b492',
      title: 'Zoom slider jumps on drag',
      labelIds: ['79878471-e70d-405d-83b7-a50dd8a853fe'],
    });
    expect(String(createdInputs[1].description)).toContain('### What happened?\nTimeline shifted after drag');
    expect(String(createdInputs[1].description)).toContain('### App context');
    expect(String(createdInputs[1].description)).toContain('- Route: `/app`');
    expect(String(createdInputs[1].description)).toContain('- Backend: gcp');

    await dialog.getByRole('button', { name: 'Done' }).click();

    // 3. Clicking non-focusable dialog heading and pressing global shortcut keys must not trigger background zoom/refresh
    const barBefore = (await page.locator('[data-task-bar="ENG-101"]').boundingBox())!.width;
    await page.getByRole('button', { name: 'Feedback' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('heading', { name: 'Send Feedback' }).click();
    await page.keyboard.press('+');
    expect((await page.locator('[data-task-bar="ENG-101"]').boundingBox())!.width).toBe(barBefore);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // 4. Mobile viewport: header stays single-line without horizontal overflow and unified Feedback button opens dialog
    await page.setViewportSize({ width: 375, height: 812 });
    const mobileHeaderBox = await page.locator('header').boundingBox();
    expect(mobileHeaderBox).not.toBeNull();
    expect(mobileHeaderBox!.height).toBeLessThanOrEqual(54);
    const mobileOverflow = await page.locator('header').evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(mobileOverflow).toBe(false);

    await page.getByRole('button', { name: 'Feedback' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'Bug Report' }).click();
    await expect(dialog.getByRole('tab', { name: 'Bug Report' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('shows pre-filled Linear fallback links when GanttSmart project is unavailable in workspace', async ({
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

      if (query.includes('FeedbackTarget')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              projects: {
                nodes: [{ id: 'proj-external', name: 'Other Workspace Project', teams: { nodes: [] } }],
              },
              teams: {
                nodes: [{ id: 'team-ext', key: 'EXT', name: 'External' }],
              },
              issueLabels: { nodes: [] },
            },
          }),
        });
        return;
      }

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
                startDate: isoOffsetDays(-5),
                targetDate: isoOffsetDays(15),
                projectMilestones: { nodes: [] },
                issues: { nodes: [] },
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

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');
    await page.getByRole('button', { name: 'Feedback' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Title/).fill('Keyboard shortcut cheat sheet');
    await dialog.getByLabel('What would help?').fill('Show a ? shortcut modal');
    await dialog.getByRole('button', { name: 'Submit Feature Request' }).click();

    const alert = dialog.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('GanttSmart');

    const prefilledLink = alert.getByRole('link', { name: 'Open pre-filled issue in Linear ↗' });
    const href = await prefilledLink.getAttribute('href');
    expect(href).toBeTruthy();
    const parsed = new URL(href!);
    expect(parsed.origin + parsed.pathname).toBe('https://linear.app/bluecoreenergy/team/IT/new');
    expect(parsed.searchParams.get('title')).toBe('Keyboard shortcut cheat sheet');
    expect(parsed.searchParams.get('description')).toContain('Show a ? shortcut modal');
    expect(parsed.searchParams.get('labels')).toBe('Feature');

    await expect(alert.getByRole('link', { name: 'Open GanttSmart project ↗' })).toHaveAttribute(
      'href',
      'https://linear.app/bluecoreenergy/project/ganttsmart-5114378da6de',
    );

    expect(errors).toEqual([]);
  });

  test('deep-links to ?project=proj-2 overriding localStorage, syncs URL on switch, and links project in Linear', async ({
    page,
    baseURL,
  }) => {
    const errors = trackErrors(page);

    const projectsList = [
      { id: 'proj-1', name: 'Alpha Platform' },
      { id: 'proj-2', name: 'Beta Mobile' },
    ];

    const projectData: Record<string, { name: string; linearUrl: string; taskId: string; title: string }> = {
      'proj-1': {
        name: 'Alpha Platform',
        linearUrl: 'https://linear.app/bluecoreenergy/project/alpha-platform-proj-1',
        taskId: 'ALP-401',
        title: 'Upgrade auth gateway',
      },
      'proj-2': {
        name: 'Beta Mobile',
        linearUrl: 'https://linear.app/bluecoreenergy/project/beta-mobile-proj-2',
        taskId: 'MOB-301',
        title: 'Ship offline cache',
      },
    };

    const externalLinksByProject: Record<
      string,
      Array<{ id: string; label: string; url: string; archivedAt: string | null }>
    > = {
      'proj-1': [],
      'proj-2': [],
    };
    const createdLinks: Array<{ projectId: string; url: string; label: string }> = [];

    await page.addInitScript(() => {
      localStorage.setItem('gantt_onboarding_done', '1');
      localStorage.setItem('gantt_theme', 'dark');
      // Intentionally set proj-1 in localStorage to verify ?project=proj-2 overrides it
      localStorage.setItem('linear_selected_project', 'proj-1');
    });

    await page
      .context()
      .route('https://linear.app/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Linear</body></html>' }),
      );

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
        variables?: { id?: string; input?: { projectId: string; url: string; label: string } };
      } | null;
      const query = payload?.query ?? '';

      if (query.includes('projects(')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { projects: { nodes: projectsList } } }),
        });
        return;
      }

      if (query.includes('externalLinks')) {
        const projectId = payload?.variables?.id ?? 'proj-2';
        const proj = projectData[projectId] ?? projectData['proj-2'];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              project: {
                url: proj.linearUrl,
                externalLinks: { nodes: externalLinksByProject[projectId] ?? [] },
              },
            },
          }),
        });
        return;
      }

      if (query.includes('entityExternalLinkCreate')) {
        const input = payload?.variables?.input;
        if (!input) {
          await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Missing input' }] }) });
          return;
        }
        createdLinks.push(input);
        const created = {
          id: `link-${createdLinks.length}`,
          label: input.label,
          url: input.url,
          archivedAt: null,
        };
        externalLinksByProject[input.projectId] = [...(externalLinksByProject[input.projectId] ?? []), created];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              entityExternalLinkCreate: {
                success: true,
                entityExternalLink: { id: created.id, label: created.label, url: created.url },
              },
            },
          }),
        });
        return;
      }

      if (query.includes('project(id:')) {
        const projectId = payload?.variables?.id ?? 'proj-2';
        const proj = projectData[projectId] ?? projectData['proj-2'];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              project: {
                name: proj.name,
                startDate: isoOffsetDays(-5),
                targetDate: isoOffsetDays(15),
                projectMilestones: { nodes: [] },
                issues: {
                  nodes: [
                    {
                      id: `uuid-${proj.taskId}`,
                      identifier: proj.taskId,
                      title: proj.title,
                      description: startTagOffsetDays(-1),
                      dueDate: isoOffsetDays(5),
                      url: `https://linear.app/bluecoreenergy/issue/${proj.taskId}`,
                      priority: 2,
                      state: { name: 'In Progress', type: 'started' },
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

    // 1. Navigating to /app?project=proj-2 overrides localStorage (proj-1) and loads proj-2
    await page.goto('/app?project=proj-2');
    await expect(page).toHaveURL(/\/app\?project=proj-2$/);
    await expect(page.getByRole('button', { name: 'Beta Mobile' })).toBeVisible();
    await expect(page.locator('[data-task-bar="MOB-301"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ALP-401"]')).toHaveCount(0);

    // 2. Switching projects keeps ?project= synchronized in the URL
    await page.getByRole('button', { name: 'Beta Mobile' }).click();
    await page.getByRole('option', { name: 'Alpha Platform' }).click();
    await expect(page).toHaveURL(/\/app\?project=proj-1$/);
    await expect(page.locator('[data-task-bar="ALP-401"]')).toBeVisible();

    await page.getByRole('button', { name: 'Alpha Platform' }).click();
    await page.getByRole('option', { name: 'Beta Mobile' }).click();
    await expect(page).toHaveURL(/\/app\?project=proj-2$/);
    await expect(page.locator('[data-task-bar="MOB-301"]')).toBeVisible();

    // 3. Clicking "Add to Linear" creates the EntityExternalLink and updates button state to "Open in Linear"
    await page.getByTitle('Account').click();
    const addBtn = page.getByRole('button', { name: 'Add to Linear' });
    await expect(addBtn).toBeVisible();
    await expect(addBtn).toHaveAttribute('title', "Add an 'Open in GanttSmart' link to this project's Linear page");
    await addBtn.click();

    await expect(page.getByText('Added "Open in GanttSmart" link to Linear project')).toBeVisible();
    expect(createdLinks).toEqual([
      {
        projectId: 'proj-2',
        url: `${baseURL}/app?project=proj-2`,
        label: 'Open in GanttSmart',
      },
    ]);
    await expect(page.getByRole('button', { name: 'Add to Linear' })).toHaveCount(0);

    await page.getByTitle('Account').click();
    const openLink = page.getByRole('link', { name: 'Open in Linear' });
    await expect(openLink).toBeVisible();

    // Verify header fits cleanly without wrapping or horizontal overflow across tablet, laptop, and mobile widths
    for (const vp of [
      { width: 1024, height: 768 },
      { width: 768, height: 900 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(vp);
      const metrics = await page.locator('header').evaluate((el) => ({
        overflow: el.scrollWidth > el.clientWidth,
        height: el.getBoundingClientRect().height,
      }));
      expect(metrics.overflow).toBe(false);
      expect(metrics.height).toBeLessThanOrEqual(54);
      const linkBox = await openLink.boundingBox();
      expect(linkBox).not.toBeNull();
      expect(linkBox!.height).toBeLessThanOrEqual(34);
    }

    await page.setViewportSize({ width: 1280, height: 720 });
    const [popup] = await Promise.all([page.waitForEvent('popup'), openLink.click()]);
    await expect(popup).toHaveURL('https://linear.app/bluecoreenergy/project/beta-mobile-proj-2');
    await popup.close();

    expect(errors).toEqual([]);
  });

  test('cycles task status when clicking or activating the status bubble without opening DetailPanel', async ({
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

    await expect(bubble101).toBeVisible();
    await expect(bubble101).toHaveAttribute('title', 'In Progress — click to cycle');

    // 1. Click status bubble: In Progress -> Done (updates completed state, does NOT open DetailPanel)
    await bubble101.click();
    await expect(bubble101).toHaveAttribute('title', 'Done — click to cycle');
    await expect(row101).toHaveAttribute('data-task-done', 'true');
    await expect(bar101).toHaveClass(/\bbar-done\b/);
    await expect(bar101).toContainText('✓ Done');
    await expect(page.getByText('Status → Done')).toBeVisible();
    await expect(page.getByText('Manifold details')).toHaveCount(0);
    expect(stateUpdates[0]).toEqual({ id: 'uuid-1', stateId: 'st-done' });

    // 2. Click status bubble while Done: skips Canceled & Duplicate, wraps to Backlog, clears completed state
    await bubble101.click();
    await expect(bubble101).toHaveAttribute('title', 'Backlog — click to cycle');
    await expect(row101).not.toHaveAttribute('data-task-done', 'true');
    await expect(bar101).not.toHaveClass(/\bbar-done\b/);
    await expect(page.getByText('Status → Backlog')).toBeVisible();
    expect(stateUpdates[1]).toEqual({ id: 'uuid-1', stateId: 'st-back' });

    // 3. Keyboard activation (Space and Enter) cycles status without opening DetailPanel or a Linear popup
    await bubble101.focus();
    await page.keyboard.press('Space');
    await expect(bubble101).toHaveAttribute('title', 'Todo — click to cycle');
    expect(stateUpdates[2]).toEqual({ id: 'uuid-1', stateId: 'st-todo' });

    await page.keyboard.press('Enter');
    await expect(bubble101).toHaveAttribute('title', 'In Progress — click to cycle');
    expect(stateUpdates[3]).toEqual({ id: 'uuid-1', stateId: 'st-prog' });
    await expect(page.getByText('Manifold details')).toHaveCount(0);

    // 4. Second team (team-2) uses its own workflow states
    const bubble102 = page.locator('[data-status-bubble="ENG-102"]');
    await expect(bubble102).toHaveAttribute('title', 'Todo — click to cycle');
    await bubble102.click();
    await expect(bubble102).toHaveAttribute('title', 'Working — click to cycle');
    expect(stateUpdates[4]).toEqual({ id: 'uuid-2', stateId: 'st2-prog' });

    // 5. Failed mutation rolls back status cleanly and displays an error toast
    failNextUpdate = true;
    await bubble102.click();
    await expect(page.getByText('Failed to update status: Permission denied')).toBeVisible();
    await expect(bubble102).toHaveAttribute('title', 'Working — click to cycle');

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

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    await page.goto('/app');

    // 1. Ghost row CTRL-42 renders inline above blocked task COMM-101 with cross-project badge and SVG arrow
    const rows = page.locator('#gantt-export-target tbody tr[data-task-id]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-task-id', 'CTRL-42');
    await expect(rows.nth(0)).toHaveAttribute('data-external-task', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-task-id', 'COMM-101');

    // FilterBar count stays scoped to current project's local tasks (1/1)
    await expect(page.getByText('1/1')).toBeVisible();

    // Cross-project SVG arrow connects CTRL-42 -> COMM-101 (flagged as violated because COMM-101 starts +2d <= CTRL-42 due +6d)
    const crossArrow = page.locator('svg path[data-arrow-source="CTRL-42"][data-arrow-target="COMM-101"]');
    await expect(crossArrow).toHaveCount(1);
    await expect(crossArrow).toHaveAttribute('data-cross-project', 'true');
    // Violated cross-project arrows keep their own color and marker, and route with rounded elbows
    await expect(crossArrow).toHaveAttribute('stroke', '#f97316');
    await expect(crossArrow).toHaveAttribute('marker-end', 'url(#dep-arrow-warn)');
    await expect(crossArrow).toHaveAttribute('d', /^M[-\d\s.HVQ,]+$/);

    // 2. Ghost row is read-only by default (status bubble is a static span, not a button)
    await expect(page.locator('button[data-status-bubble="CTRL-42"]')).toHaveCount(0);
    await expect(page.locator('span[data-status-bubble="CTRL-42"]')).toBeVisible();

    // 3. Ghost row can be moved up and down like a normal row (Alt+ArrowDown)
    await rows.nth(0).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(rows.nth(0)).toHaveAttribute('data-task-id', 'COMM-101');
    await expect(rows.nth(1)).toHaveAttribute('data-task-id', 'CTRL-42');

    // 4. Activating write mode ("Edit external") makes CTRL-42 directly editable inline
    const editExternalBtn = page.getByRole('button', { name: 'Edit external' });
    await editExternalBtn.click();
    await expect(page.getByRole('button', { name: 'Editing external' })).toHaveAttribute('aria-pressed', 'true');

    const ctrlBubbleBtn = page.locator('button[data-status-bubble="CTRL-42"]');
    await expect(ctrlBubbleBtn).toBeVisible();
    await ctrlBubbleBtn.click();
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

      if (query.includes('issue(id:')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { issue: { description: initialDescription } } }),
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
    await expect.poll(() => descUpdates.length).toBe(1);

    expect(dueUpdates[0]).toBe(isoOffsetDays(tueNextOffset));
    expect(descUpdates[0]).toContain(startTagOffsetDays(wedOffset));

    // DetailPanel reflects the preserved 5-workday duration
    await bar.click();
    await expect(page.getByText('5 workdays')).toBeVisible();

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

    // Default columns: issue, assignee, status, due date — priority is no longer shown
    expect(await headerLabels()).toEqual(['ISSUE', 'ASSIGNEE', 'STATUS', 'DUE']);

    // Assignee and status are real columns, not just icons in the task cell
    const assigneeCell = page.locator('tr[data-task-id="ENG-101"] td').nth(1);
    await expect(assigneeCell).toContainText('Andrew Phillips');
    const statusCell = page.locator('tr[data-task-id="ENG-101"] td').nth(2);
    await expect(statusCell).toContainText('In Progress');
    await expect(statusCell.locator('[data-status-bubble="ENG-101"]')).toBeVisible();

    // Right-clicking a header opens the picker, as does its header button
    await headers.nth(1).click({ button: 'right' });
    const picker = page.getByRole('group', { name: 'Columns' });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole('checkbox', { name: 'Issue', exact: true })).toBeDisabled();
    await expect(picker.getByRole('checkbox', { name: 'Issue', exact: true })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);

    const pickerButton = page.getByRole('button', { name: 'Choose columns' });
    await pickerButton.click();
    await expect(picker).toBeVisible();

    // Every optional column can be shown, and lands in the canonical order
    for (const label of ['Start date', 'Priority', 'Project', 'Sub-issue progress', 'Issue ID']) {
      await picker.getByRole('checkbox', { name: label }).check();
    }
    expect(await headerLabels()).toEqual([
      'ISSUE',
      'ASSIGNEE',
      'STATUS',
      'START',
      'DUE',
      'PRIORITY',
      'PROJECT',
      'SUB-ISSUES',
      'ID',
    ]);
    await expect(page.locator('tr[data-task-id="ENG-101"]')).toContainText('Demo Project');
    await expect(page.locator('tr[data-task-id="ENG-101"] td').nth(8)).toContainText('ENG-101');

    // ...and hidden again
    await picker.getByRole('checkbox', { name: 'Assignee' }).uncheck();
    expect(await headerLabels()).not.toContain('ASSIGNEE');
    await picker.getByRole('checkbox', { name: 'Assignee' }).check();

    // Hiding the status column keeps click-to-cycle reachable in the task cell
    await picker.getByRole('checkbox', { name: 'Status' }).uncheck();
    expect(await headerLabels()).not.toContain('STATUS');
    await expect(page.locator('button[data-status-bubble="ENG-101"]')).toBeVisible();
    await picker.getByRole('checkbox', { name: 'Status' }).check();

    // The last optional column can't be hidden: that would leave only the issue column
    for (const label of ['Assignee', 'Status', 'Start date', 'Due date', 'Priority', 'Project', 'Sub-issue progress']) {
      await picker.getByRole('checkbox', { name: label }).uncheck();
    }
    expect(await headerLabels()).toEqual(['ISSUE', 'ID']);
    await expect(picker.getByRole('checkbox', { name: 'Issue ID' })).toBeDisabled();
    await picker.getByRole('checkbox', { name: 'Due date' }).check();
    await expect(picker.getByRole('checkbox', { name: 'Issue ID' })).toBeEnabled();

    // Back to a full set for the resize and reload checks below
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    for (const label of ['Start date', 'Priority', 'Project', 'Sub-issue progress', 'Issue ID']) {
      await picker.getByRole('checkbox', { name: label }).check();
    }
    await page.keyboard.press('Escape');

    // Resizing works for a column that isn't shown by default
    const statusHeader = headers.nth(2);
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
      'ISSUE',
      'ASSIGNEE',
      'STATUS',
      'START',
      'DUE',
      'PRIORITY',
      'PROJECT',
      'SUB-ISSUES',
      'ID',
    ]);
    expect((await headers.nth(2).boundingBox())!.width).toBeCloseTo(after.width, 0);

    // Reset puts the defaults back
    await page.getByRole('button', { name: 'Choose columns' }).click();
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    expect(await headerLabels()).toEqual(['ISSUE', 'ASSIGNEE', 'STATUS', 'DUE']);

    expect(errors).toEqual([]);
  });

  test('zooms anchored under pointer via Ctrl+wheel, switches granularity, and pans by dragging background', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    const updatedDates: string[] = [];

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
                  { id: 'uuid-1', identifier: 'ENG-101', relations: { nodes: [] }, children: { nodes: [] } },
                  { id: 'uuid-2', identifier: 'ENG-102', relations: { nodes: [] }, children: { nodes: [] } },
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

      if (query.includes('issue(id:')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: { issue: { description: `${startTagOffsetDays(-5)}\nDesign` } } }),
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

    // 4. Ctrl+wheel over the fixed Task column does not jump scrollLeft, and clamping at max zoom leaves no stale anchor
    await scroller.evaluate((el) => {
      el.scrollLeft = 0;
    });
    const taskCell = page.locator('tr[data-task-id="ENG-101"] td').first();
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

    const openPicker = async () => {
      await page.getByRole('button', { name: 'Filter', exact: true }).click();
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
    await openPicker();
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
    // The first Escape closes the date popover, the second the filter panel around it
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: 'Filters' })).toHaveCount(0);
    await openPicker();
    const mobile = await layout();
    expect(mobile.noHorizontalScroll).toBe(true);
    expect(mobile.navBottom).toBeLessThanOrEqual(mobile.gridTop);
    expect(mobile.popRight).toBeLessThanOrEqual(375);

    expect(errors).toEqual([]);
  });
});
