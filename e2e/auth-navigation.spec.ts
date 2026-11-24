import { expect, test } from '@playwright/test';
import { blockFonts, createScheduleMock, isoOffsetDays, startTagOffsetDays, trackErrors } from './helpers/index.js';

let defaultScheduleMock = createScheduleMock();

test.describe('GanttSmart GCP app', () => {
  test.beforeEach(async ({ page }) => {
    defaultScheduleMock = createScheduleMock();
    await blockFonts(page);
  });

  test('redirects / to /app, shows Connect Linear, and blocks share route', async ({ page }) => {
    const errors = trackErrors(page);

    await page.goto('/');
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('heading', { name: 'Connect to Linear' })).toBeVisible();
    await expect(page.getByText('dev@bluecore.energy')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect Linear Account' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out of GanttSmart', exact: true })).toBeVisible();
    await expect(page.getByText('Signs out of GanttSmart only, not Google.')).toHaveCount(0);

    await page.goto('/share/some-token');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
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
      if (await defaultScheduleMock.handle(route, payload)) return;

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

    // No milestones in Demo Project, so pinned milestone row is omitted
    await expect(page.locator('tr[data-milestone-row]')).toHaveCount(0);

    // Set a task search filter to verify Escape in project search doesn't clear task search
    const taskSearch = page.getByPlaceholder('Search tasks…');
    await taskSearch.fill('manifold');
    await expect(page.locator('[data-task-bar="ENG-101"]')).toBeVisible();

    // The project switcher lives in the header breadcrumb, not in the filter bar
    const header = page.locator('header');
    const projectTrigger = header.getByRole('button', { name: 'Demo Project' });
    await expect(projectTrigger).toBeVisible();
    await expect(page.getByRole('button', { name: 'Demo Project' })).toHaveCount(1);
    await expect(page.getByTestId('filter-bar').getByRole('button', { name: 'Demo Project' })).toHaveCount(0);
    await expect(header.getByText('Roadmap', { exact: true })).toHaveCount(0);

    // Open project dropdown — search input receives focus automatically
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

    // Tab from the search input closes the dropdown and moves focus to the next control (Sync)
    await page.getByRole('button', { name: 'Valve Actuator' }).click();
    await expect(projectSearch).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(projectSearch).toHaveCount(0);
    await expect(header.getByRole('button', { name: 'Sync' })).toBeFocused();

    expect(errors).toEqual([]);
  });

  test('lets the user switch away from a project that fails to load', async ({ page }) => {
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
        variables?: { id?: string };
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
                  { id: 'proj-1', name: 'Broken Project' },
                  { id: 'proj-2', name: 'Beta Mobile' },
                ],
              },
            },
          }),
        });
        return;
      }

      if (query.includes('project(id:')) {
        if (payload?.variables?.id === 'proj-1') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ errors: [{ message: 'Forbidden: no access to this project' }] }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              project: {
                name: 'Beta Mobile',
                startDate: isoOffsetDays(-5),
                targetDate: isoOffsetDays(15),
                projectMilestones: { nodes: [] },
                issues: {
                  nodes: [
                    {
                      id: 'uuid-MOB-301',
                      identifier: 'MOB-301',
                      title: 'Ship offline cache',
                      description: startTagOffsetDays(-1),
                      dueDate: isoOffsetDays(5),
                      url: 'https://linear.app/bluecoreenergy/issue/MOB-301',
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
            data: { workflowStates: { nodes: [{ id: 'st-1', name: 'Todo', type: 'unstarted', position: 0 }] } },
          }),
        });
        return;
      }

      await route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
    });

    // The failure shows on the error screen and, separately, in a "Failed to load issues: …" toast.
    // Assert on the error screen only: its heading, and its paragraph via an exact text match (the
    // toast text has a prefix, so it can't match). Nothing here depends on the toast's 8s lifetime.
    const errorHeading = page.getByRole('heading', { name: 'Something went wrong' });
    const errorMessage = page.getByText('Forbidden: no access to this project', { exact: true });

    await page.goto('/app');
    await expect(errorHeading).toBeVisible();
    await expect(errorMessage).toBeVisible();

    // The saved project is broken, but the breadcrumb switcher is still there
    const projectTrigger = page.locator('header').getByRole('button', { name: 'Broken Project' });
    await expect(projectTrigger).toBeVisible();
    await projectTrigger.click();
    await page.getByRole('option', { name: 'Beta Mobile' }).click();

    await expect(page.locator('[data-task-bar="MOB-301"]')).toBeVisible();
    await expect(errorHeading).toHaveCount(0);
    await expect(errorMessage).toHaveCount(0);
    await expect(page).toHaveURL(/\/app\?project=proj-2$/);
    await expect(page.locator('header').getByRole('button', { name: 'Beta Mobile' })).toBeVisible();
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
      if (await defaultScheduleMock.handle(route, payload)) return;

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
    // The breadcrumb project switcher stays reachable (and inside the header) on narrow screens
    const mobileProjectBox = await page.locator('header').getByRole('button', { name: 'Demo Project' }).boundingBox();
    const mobileSyncBox = await page.locator('header').getByTitle('Refresh (R)').boundingBox();
    expect(mobileProjectBox).not.toBeNull();
    expect(mobileSyncBox).not.toBeNull();
    // Not overlapping Sync, and still wide enough to read the project name
    expect(mobileProjectBox!.x + mobileProjectBox!.width).toBeLessThanOrEqual(mobileSyncBox!.x);
    expect(mobileProjectBox!.width).toBeGreaterThan(60);

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
      if (await defaultScheduleMock.handle(route, payload)) return;

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
      if (await defaultScheduleMock.handle(route, payload)) return;

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
});
