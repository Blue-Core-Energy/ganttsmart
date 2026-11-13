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
});
