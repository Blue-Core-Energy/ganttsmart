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

    // Account menu shows GCP Sign out + note
    await page.getByTitle('Account').click();
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

    // Time scale toggle updates aria-pressed
    const weekBtn = page.getByRole('button', { name: 'week', exact: true });
    const dayBtn = page.getByRole('button', { name: 'day', exact: true });
    await weekBtn.click();
    await expect(weekBtn).toHaveAttribute('aria-pressed', 'true');
    await dayBtn.click();
    await expect(dayBtn).toHaveAttribute('aria-pressed', 'true');

    // Clicking a task bar opens DetailPanel and Escape closes it
    await page.locator('[data-task-bar="ENG-101"]').click();
    await expect(page.getByText('Manifold details')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Manifold details')).toHaveCount(0);

    // Theme toggle flips dark/light class on <html>
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
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

    // Tab from the search input closes the dropdown and moves focus to the next control (Assignee)
    await page.getByRole('button', { name: 'Valve Actuator' }).click();
    await expect(projectSearch).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(projectSearch).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Assignee' })).toBeFocused();

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

    // Status filter excludes Duplicate / Rejected
    await page.getByRole('button', { name: 'Status', exact: true }).click();
    await expect(page.getByRole('option', { name: 'In Progress', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Todo', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Duplicate', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: 'Rejected', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Status', exact: true }).first().click();

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
    await expect(exportTarget.locator('svg path[marker-end="url(#dep-arrow)"]')).toHaveCount(1);

    // FilterBar fits cleanly within the 1280px viewport without horizontal clipping
    const countBox = await page.getByText('3/3').boundingBox();
    expect(countBox).not.toBeNull();
    expect(countBox!.x + countBox!.width).toBeLessThanOrEqual(1280);

    // DetailPanel shows Completed (not overdue) for past-due completed tasks
    await doneBar.click();
    await expect(page.getByText('CAD completed early')).toBeVisible();
    await expect(page.getByText('(Completed)')).toBeVisible();
    await page.keyboard.press('Escape');

    // Grouping by status places completed task in its own status group inside the same table
    await page.getByRole('button', { name: 'No grouping' }).click();
    await page.getByRole('option', { name: 'Group by status' }).click();
    await expect(exportTarget.locator('table')).toHaveCount(1);
    await expect(exportTarget.locator('tbody tr[data-task-id]')).toHaveCount(3);
    await expect(exportTarget.getByText('Done').first()).toBeVisible();

    // Reset grouping to none
    await page.getByRole('button', { name: 'Group by status' }).click();
    await page.getByRole('option', { name: 'No grouping' }).click();

    // Completed filter toggle hides and restores completed tasks without a separate section
    const completedToggle = page.getByRole('button', { name: 'Completed', exact: true });
    await expect(completedToggle).toHaveAttribute('aria-pressed', 'true');
    await completedToggle.click();
    await expect(completedToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('[data-task-bar="ENG-100"]')).toHaveCount(0);
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();
    await expect(page.getByText('2/3')).toBeVisible();
    await expect(page.getByText('Completed hidden')).toBeVisible();

    await completedToggle.click();
    await expect(page.locator('[data-task-bar="ENG-100"]')).toBeVisible();
    await expect(page.getByText('3/3')).toBeVisible();

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
                          labels: {
                            nodes: [
                              { id: '6ef1fd41-af6d-48ec-ae08-2a529cfc0013', name: 'Feature' },
                              { id: '79878471-e70d-405d-83b7-a50dd8a853fe', name: 'Bug' },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              teams: { nodes: [] },
              issueLabels: { nodes: [] },
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

    // 1. Open Feature Request modal
    await page.getByRole('button', { name: 'Feature Request' }).click();
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

    // 2. Open Bug Report modal from header button
    await page.getByRole('button', { name: 'Bug Report' }).click();
    await expect(dialog).toBeVisible();
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
    const zoomLabel = page.locator('header span.font-mono', { hasText: /^\d+$/ }).first();
    const zoomBefore = await zoomLabel.textContent();
    await page.getByRole('button', { name: 'Bug Report' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('heading', { name: 'Send Feedback' }).click();
    await page.keyboard.press('+');
    await expect(zoomLabel).toHaveText(zoomBefore!);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // 4. Mobile viewport: header stays single-line without horizontal overflow and compact Feedback menu opens Bug Report
    await page.setViewportSize({ width: 375, height: 812 });
    const mobileHeaderBox = await page.locator('header').boundingBox();
    expect(mobileHeaderBox).not.toBeNull();
    expect(mobileHeaderBox!.height).toBeLessThanOrEqual(54);
    const mobileOverflow = await page.locator('header').evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(mobileOverflow).toBe(false);

    await page.getByRole('button', { name: 'Send feedback' }).click();
    await page.getByRole('button', { name: 'Bug Report' }).click();
    await expect(dialog).toBeVisible();
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
                nodes: [{ id: 'team-ext', key: 'EXT', name: 'External', labels: { nodes: [] } }],
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
    await page.getByRole('button', { name: 'Feature Request' }).click();

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
});
