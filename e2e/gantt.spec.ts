import { expect, test, type Page, type Route } from '@playwright/test';

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

interface MockScheduleComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Mocks the GanttSmart schedule-comment GraphQL operations: the batched `ScheduleComments` read,
 * the per-issue `IssueSchedule` read, `commentCreate` and `commentUpdate`.
 */
function createScheduleMock(initial: { description?: string | null; dueDate?: string | null } = {}) {
  const state = {
    description: initial.description ?? null,
    dueDate: initial.dueDate ?? null,
    comments: [] as MockScheduleComment[],
    creates: [] as string[],
    updates: [] as string[],
  };

  const respond = (route: Route, data: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });

  async function handle(
    route: Route,
    payload: { query?: string; variables?: Record<string, unknown> } | null,
  ): Promise<boolean> {
    const query = payload?.query ?? '';
    const variables = payload?.variables ?? {};

    if (query.includes('ScheduleComments')) {
      await respond(route, { issues: { nodes: [] } });
      return true;
    }
    if (query.includes('IssueSchedule')) {
      await respond(route, {
        issue: {
          description: state.description,
          dueDate: state.dueDate,
          updatedAt: '2026-01-01T00:00:00Z',
          comments: { nodes: state.comments },
        },
      });
      return true;
    }
    if (query.includes('commentCreate')) {
      const body = String(variables.body ?? '');
      state.creates.push(body);
      state.comments.push({
        id: `comment-${state.comments.length + 1}`,
        body,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await respond(route, { commentCreate: { success: true } });
      return true;
    }
    if (query.includes('commentUpdate')) {
      const body = String(variables.body ?? '');
      state.updates.push(body);
      const target = state.comments.find((c) => c.id === variables.commentId);
      if (target) {
        target.body = body;
        target.updatedAt = new Date().toISOString();
      }
      await respond(route, { commentUpdate: { success: true } });
      return true;
    }
    return false;
  }

  return { state, handle };
}

let defaultScheduleMock = createScheduleMock();

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

interface MockIssue {
  id: string;
  identifier: string;
  title: string;
  assignee: string;
  startOffset: number;
  dueOffset: number;
}

interface NonWorkDayEntry {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  assigneeName: string | null;
}

/** Monday of the coming week (or today when it is a Monday), as a day offset from today. */
function mondayOffset(): number {
  return (8 - localOffsetDate(0).getDay()) % 7;
}

/**
 * Serves the holidays/PTO API from memory so these tests never touch the shared dev server's
 * calendar (other tests run against the same server in parallel).
 */
async function mockNonWorkDayApi(page: Page, initial: NonWorkDayEntry[] = []): Promise<NonWorkDayEntry[]> {
  const entries = [...initial];
  let counter = 0;
  await page.route('**/api/non-work-days**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ nonWorkDays: entries }),
      });
      return;
    }
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Omit<NonWorkDayEntry, 'id'>;
      const entry: NonWorkDayEntry = {
        id: `nwd-${++counter}`,
        label: body.label,
        startDate: body.startDate,
        endDate: body.endDate ?? body.startDate,
        assigneeName: body.assigneeName ?? null,
      };
      entries.push(entry);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ nonWorkDay: entry }),
      });
      return;
    }
    const id = decodeURIComponent(new URL(req.url()).pathname.split('/').pop() ?? '');
    const at = entries.findIndex((e) => e.id === id);
    if (at >= 0) entries.splice(at, 1);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  return entries;
}

/** Mocks Linear for one project; returns the due-date and start-date updates the app sends, by issue id. */
async function mockLinearIssues(page: Page, issues: MockIssue[]) {
  const dueUpdates: Array<{ id: string; dueDate: string }> = [];
  const startUpdates: Array<{ id: string; body: string }> = [];
  const descriptionOf = (i: MockIssue) => `${startTagOffsetDays(i.startOffset)}\n${i.title}`;
  const currentStartById = new Map(issues.map((i) => [i.id, isoOffsetDays(i.startOffset)]));
  const currentDueById = new Map(issues.map((i) => [i.id, isoOffsetDays(i.dueOffset)]));
  const commentsByIssue = new Map<string, Array<{ id: string; body: string; createdAt: string; updatedAt: string }>>();

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
      variables?: {
        id?: string;
        dueDate?: string;
        description?: string;
        issueId?: string;
        commentId?: string;
        body?: string;
      };
    } | null;
    const query = payload?.query ?? '';
    const reply = (data: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });

    const recordScheduleBody = (issueId: string, body: string) => {
      const m = body.match(/start:\s*(\d{4}-\d{2}-\d{2})/i);
      if (m && m[1] !== currentStartById.get(issueId)) {
        currentStartById.set(issueId, m[1]);
        startUpdates.push({ id: issueId, body });
      }
    };

    if (query.includes('projects(')) return reply({ projects: { nodes: [{ id: 'proj-1', name: 'Demo Project' }] } });
    if (query.includes('externalLinks')) {
      return reply({
        project: { url: 'https://linear.app/bluecoreenergy/project/demo', externalLinks: { nodes: [] } },
      });
    }
    if (query.includes('project(id:')) {
      const last = Math.max(...issues.map((i) => i.dueOffset));
      return reply({
        project: {
          name: 'Demo Project',
          startDate: isoOffsetDays(Math.min(...issues.map((i) => i.startOffset)) - 2),
          targetDate: isoOffsetDays(last + 10),
          projectMilestones: { nodes: [] },
          issues: {
            nodes: issues.map((i) => ({
              id: i.id,
              identifier: i.identifier,
              title: i.title,
              description: descriptionOf(i),
              dueDate: isoOffsetDays(i.dueOffset),
              url: `https://linear.app/bluecoreenergy/issue/${i.identifier}`,
              priority: 3,
              state: { name: 'Todo', type: 'unstarted' },
              createdAt: '2026-01-01T00:00:00Z',
              completedAt: null,
              assignee: { name: i.assignee },
              team: { id: 'team-1' },
              projectMilestone: null,
            })),
          },
          doneIssues: { nodes: [] },
        },
      });
    }
    if (query.includes('relations')) return reply({ issues: { nodes: [] } });
    if (query.includes('ScheduleComments')) return reply({ issues: { nodes: [] } });
    if (query.includes('IssueSchedule')) {
      const issueId = String(payload?.variables?.id ?? '');
      const issue = issues.find((i) => i.id === issueId);
      return reply({
        issue: {
          description: issue ? descriptionOf(issue) : '',
          dueDate: currentDueById.get(issueId) ?? null,
          updatedAt: '2026-01-01T00:00:00Z',
          comments: { nodes: commentsByIssue.get(issueId) ?? [] },
        },
      });
    }
    if (query.includes('commentCreate')) {
      const issueId = String(payload?.variables?.issueId ?? '');
      const body = String(payload?.variables?.body ?? '');
      const now = new Date().toISOString();
      const list = commentsByIssue.get(issueId) ?? [];
      list.push({ id: `comment-${issueId}-${list.length + 1}`, body, createdAt: now, updatedAt: now });
      commentsByIssue.set(issueId, list);
      recordScheduleBody(issueId, body);
      return reply({ commentCreate: { success: true } });
    }
    if (query.includes('commentUpdate')) {
      const commentId = String(payload?.variables?.commentId ?? '');
      const body = String(payload?.variables?.body ?? '');
      for (const [issueId, list] of commentsByIssue.entries()) {
        const hit = list.find((c) => c.id === commentId);
        if (hit) {
          hit.body = body;
          hit.updatedAt = new Date().toISOString();
          recordScheduleBody(issueId, body);
          break;
        }
      }
      return reply({ commentUpdate: { success: true } });
    }
    if (query.includes('workflowStates')) {
      return reply({ workflowStates: { nodes: [{ id: 'st-1', name: 'Todo', type: 'unstarted', position: 0 }] } });
    }
    if (query.includes('issue(id:')) {
      const issue = issues.find((i) => i.id === payload?.variables?.id);
      return reply({ issue: { description: issue ? descriptionOf(issue) : '' } });
    }
    if (query.includes('issueUpdate')) {
      const { id = '', dueDate, description } = payload?.variables ?? {};
      if (dueDate) {
        currentDueById.set(id, dueDate);
        dueUpdates.push({ id, dueDate });
      }
      if (description) startUpdates.push({ id, body: description });
      return reply({ issueUpdate: { success: true } });
    }
    return route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
  });

  return { dueUpdates, startUpdates };
}

async function openNonWorkDaysDialog(page: Page): Promise<void> {
  await page.getByTitle('Account').click();
  await page.getByRole('button', { name: /Holidays \/ PTO/ }).click();
}

async function addNonWorkDayViaDialog(
  page: Page,
  entry: { label: string; start: string; end?: string; person?: string },
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Holidays and PTO' });
  await openNonWorkDaysDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(entry.label);
  await dialog.getByLabel('Start date', { exact: true }).fill(entry.start);
  if (entry.end) await dialog.getByLabel(/^End date/).fill(entry.end);
  if (entry.person) {
    await dialog.getByLabel('Applies to', { exact: true }).selectOption('person');
    await dialog.getByLabel('Person', { exact: true }).fill(entry.person);
  }
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.locator(`[data-non-work-entry="${entry.label}"]`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

test.describe('GanttSmart GCP app', () => {
  test.beforeEach(async ({ page }) => {
    defaultScheduleMock = createScheduleMock();
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
    const unscheduledToggle = unscheduledSection.getByRole('button', { name: /Unscheduled/ });
    await expect(unscheduledSection.getByTestId('unscheduled-count')).toHaveText('1');
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

    // StatsRow and FilterBar reflect unified counts (3/3 total, 1 completed)
    await expect(page.getByText('3/3')).toBeVisible();
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
    await expect(page.locator('[data-status-bubble="ENG-101"]')).toHaveAttribute('title', 'Done — click to cycle');
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
      'In Progress — click to cycle',
    );
    expect(updates[1]).toEqual({ id: 'uuid-1', stateId: 'st-prog' });

    // The status bubble still cycles without opening the menu
    await page.locator('[data-status-bubble="ENG-102"]').click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('[data-status-bubble="ENG-102"]')).toHaveAttribute(
      'title',
      'In Progress — click to cycle',
    );
    expect(updates[2]).toEqual({ id: 'uuid-2', stateId: 'st-prog' });

    // Failed mutation rolls the status back and shows an error toast
    failNextUpdate = true;
    await row102.getByRole('button', { name: 'Change status, currently In Progress' }).click();
    await menu.getByRole('option', { name: 'Backlog' }).click();
    await expect(page.getByText('Failed to update status: Permission denied')).toBeVisible();
    await expect(page.locator('[data-status-bubble="ENG-102"]')).toHaveAttribute(
      'title',
      'In Progress — click to cycle',
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

    // Typing shortcuts ('r' refreshes, 's' cycles status) must stay inside the search box
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
      'In Progress — click to cycle',
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
    // Release elsewhere so the press does not count as a click that cycles the status
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
    await expect.poll(() => schedule.state.creates.length + schedule.state.updates.length).toBe(2);

    expect(dueUpdates[0]).toBe(isoOffsetDays(tueNextOffset));
    // Both dates land in one schedule comment (created once, then updated in place); the description is untouched
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

    // Hiding the status column keeps click-to-cycle reachable in the task cell
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
              // LOC-304 also warns (depth four with a warning); LOC-305 is the deepest row, with only the dot
              relationsOf(304, [{ type: 'blocked_by', relatedIssue: { identifier: 'LOC-310' } }], [305, 306]),
              relationsOf(305, [], []),
              // LOC-306 is a depth-five sibling that also warns, the tightest row a rename can happen on
              relationsOf(306, [{ type: 'blocked_by', relatedIssue: { identifier: 'LOC-310' } }], []),
              relationsOf(
                310,
                [
                  { type: 'blocks', relatedIssue: { identifier: 'LOC-303' } },
                  { type: 'blocks', relatedIssue: { identifier: 'LOC-304' } },
                  { type: 'blocks', relatedIssue: { identifier: 'LOC-306' } },
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

    // The widest lines the Issue cell can hold at 200px: deep indents (3 and 4 with a warning, 5 with just the
    // dot, which is the only status control on a phone) and an external row (always top level) with its project
    // badge and a warning
    // `minTitle` is how much of the title must survive. Depth five with a warning is the tightest row: its
    // 42px line holds the 10px warning, the 8px dot and two 6px gaps, which leaves about 12px, so the title is
    // down to an ellipsis there by geometry rather than by layout choice
    for (const { id, warns, minTitle } of [
      { id: 'LOC-303', warns: true, minTitle: 16 },
      { id: 'LOC-304', warns: true, minTitle: 16 },
      { id: 'LOC-305', warns: false, minTitle: 16 },
      { id: 'LOC-306', warns: true, minTitle: 10 },
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

    // Renaming hides the project badge and warning (both informational) so the input gets their room, keeps the
    // dot, and the warning returns afterwards. Depth five is the tightest row: its 42px line holds the 8px dot and
    // a 6px gap, so about 28px is the most any input can get there, which is enough for a couple of characters.
    // The floors are what the layout delivers (63, 45 and 27px) less a pixel or two of slack
    const warning = (id: string) =>
      page.locator(`tr[data-task-id="${id}"] td[data-column-key="task"] span[title^="Starts before"]`);
    const renameWidths: Record<string, number> = {};
    for (const { id, minInput } of [
      { id: 'LOC-303', minInput: 60 },
      { id: 'LOC-304', minInput: 42 },
      { id: 'LOC-305', minInput: 24 },
      { id: 'LOC-306', minInput: 24 },
    ]) {
      const hasWarning = id !== 'LOC-305';
      await expect(warning(id)).toHaveCount(hasWarning ? 1 : 0);
      await page.locator(`[data-task-title="${id}"]`).dblclick();
      const input = page.locator('input[data-inline-edit="title"]');
      await expect(input).toBeFocused();
      await expect(warning(id)).toHaveCount(0);
      const inputBox = (await input.boundingBox())!;
      const dotBox = (await page.locator(`[data-status-bubble="${id}"]`).boundingBox())!;
      expect(inputBox.width).toBeGreaterThanOrEqual(minInput);
      expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(dotBox.x);
      renameWidths[id] = inputBox.width;
      await page.keyboard.press('Escape');
      await expect(input).toHaveCount(0);
      await expect(warning(id)).toHaveCount(hasWarning ? 1 : 0);
    }
    // The warning costs a rename nothing: depth five with one gets the same width as depth five without
    expect(Math.abs(renameWidths['LOC-306'] - renameWidths['LOC-305'])).toBeLessThanOrEqual(1);
    expect(stateUpdates).toEqual([]);

    // Click-to-cycle still works from the deepest rows
    await page.locator('[data-status-bubble="LOC-303"]').click();
    await expect.poll(() => stateUpdates).toEqual(['uuid-303']);
    await page.locator('[data-status-bubble="LOC-305"]').click();
    await expect.poll(() => stateUpdates).toEqual(['uuid-303', 'uuid-305']);

    expect(errors).toEqual([]);
  });

  test('keeps frozen cells above milestone lines on completed rows while only fading cell contents', async ({
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
      const json = (data: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });

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
    const milestoneLine = page.locator('[data-milestone-line="ms-1"]');
    await expect(milestoneLine).toHaveCount(1);

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

    // Scroll horizontally until the milestone line sits underneath the last frozen (due) column
    const scrollContainer = page.locator('#gantt-export-target');
    const doneDueCell = doneRow.locator('td[data-column-key="due"]');
    const cellBox = (await doneDueCell.boundingBox())!;
    const lineBox = (await milestoneLine.boundingBox())!;
    const targetX = cellBox.x + cellBox.width / 2;
    await scrollContainer.evaluate((el, delta) => {
      el.scrollLeft += delta;
    }, lineBox.x - targetX);
    await expect
      .poll(async () => Math.round((await milestoneLine.boundingBox())!.x))
      .toBeCloseTo(Math.round(targetX), -1);

    // Hit-testing respects paint order, so make the (pointer-events: none) line hit-testable temporarily
    const hit = await page.evaluate(() => {
      const line = document.querySelector('[data-milestone-line="ms-1"]') as HTMLElement;
      const cell = document.querySelector('tr[data-task-id="ENG-100"] td[data-column-key="due"]') as HTMLElement;
      line.style.pointerEvents = 'auto';
      const lineRect = line.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      const x = lineRect.left + lineRect.width / 2;
      const y = cellRect.top + cellRect.height / 2;
      const top = document.elementFromPoint(x, y);
      const result = {
        lineInsideCell: x > cellRect.left && x < cellRect.right,
        topIsLine: top === line || line.contains(top),
        topInCell: Boolean(top && cell.contains(top)),
      };
      line.style.pointerEvents = '';
      return result;
    });
    expect(hit.lineInsideCell).toBe(true);
    expect(hit.topIsLine).toBe(false);
    expect(hit.topInCell).toBe(true);

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
    expect(mobile.popLeft).toBeGreaterThanOrEqual(0);
    expect(mobile.popRight).toBeLessThanOrEqual(375);

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
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.getByRole('button', { name: 'Any assignee' }).click();
    await page.getByRole('option', { name: /Nate Jones/ }).click();
    await expect(page.locator('[data-task-bar="ENG-202"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-203"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-210"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ENG-200"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('adds a company holiday and per-person PTO, shades the timeline, and snaps affected tasks forward', async ({
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
    const entries = await mockNonWorkDayApi(page);

    await page.goto('/app');
    const barWidth = async (id: string) => (await page.locator(`[data-task-bar="${id}"]`).boundingBox())!.width;
    await expect(page.locator('[data-task-bar="ENG-201"]')).toBeVisible();
    await expect(page.locator('[data-non-work-day]')).toHaveCount(0);
    const dayWidth = 28;
    expect(await barWidth('ENG-201')).toBeCloseTo(3 * dayWidth, 0); // Mon–Wed
    expect(await barWidth('ENG-202')).toBeCloseTo(3 * dayWidth, 0); // Wed–Fri

    // 1. Company-wide holiday
    await addNonWorkDayViaDialog(page, { label: 'Company Retreat', start: isoOffsetDays(wed) });
    expect(entries).toEqual([
      expect.objectContaining({
        label: 'Company Retreat',
        startDate: isoOffsetDays(wed),
        endDate: isoOffsetDays(wed),
        assigneeName: null,
      }),
    ]);

    // Shaded on every row and in the date ruler, with the holiday name on hover
    for (const id of ['ENG-201', 'ENG-202', 'ENG-203']) {
      const shade = page.locator(`tr[data-task-id="${id}"] [data-non-work-day="Company Retreat"]`);
      await expect(shade).toHaveCount(1);
      await expect(shade).toHaveAttribute('data-non-work-scope', 'company');
      await expect(shade).toHaveAttribute('title', /Company Retreat/);
    }
    const headerShade = page.locator('[data-header-holiday="Company Retreat"]');
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

    // 2. Per-person PTO for Nate on Thu: only Nate's tasks are affected
    await addNonWorkDayViaDialog(page, { label: 'Nate PTO', start: isoOffsetDays(thu), person: 'Nate Jones' });
    expect(entries[1]).toMatchObject({ label: 'Nate PTO', assigneeName: 'Nate Jones' });

    for (const id of ['ENG-202', 'ENG-203']) {
      const shade = page.locator(`tr[data-task-id="${id}"] [data-non-work-day="Nate PTO"]`);
      await expect(shade).toHaveCount(1);
      await expect(shade).toHaveAttribute('data-non-work-scope', 'pto');
      await expect(shade).toHaveAttribute('title', /Nate PTO · Nate Jones out/);
    }
    await expect(page.locator('tr[data-task-id="ENG-201"] [data-non-work-day="Nate PTO"]')).toHaveCount(0);
    // PTO is not a company holiday, so the date ruler does not mark it
    await expect(page.locator('[data-header-holiday]')).toHaveCount(1);

    // ENG-202 started on Thu (snapped earlier), now Nate's PTO: Thu -> Fri
    await expect(page.getByText('Nate PTO added: moved 1 task to the next workday')).toBeVisible();
    await expect.poll(() => startUpdates.map((u) => u.id)).toEqual(['uuid-202', 'uuid-202']);
    expect(startUpdates[1].body).toContain(`start: ${isoOffsetDays(fri)}`);
    expect(dueUpdates).toEqual([{ id: 'uuid-201', dueDate: isoOffsetDays(thu) }]); // Andrew's task is untouched
    await expect.poll(() => barWidth('ENG-202')).toBeCloseTo(1 * dayWidth, 0); // Fri only

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
    const entries = await mockNonWorkDayApi(page);

    await page.goto('/app');
    const bar = page.locator('[data-task-bar="ENG-211"]');
    await expect(bar).toBeVisible();

    // Nothing lands on a far-away holiday: a plain confirmation, no snapping
    await addNonWorkDayViaDialog(page, {
      label: 'Far Future',
      start: isoOffsetDays(mon + 40),
      end: isoOffsetDays(mon + 41),
    });
    await expect(page.getByText('Added Far Future')).toBeVisible();
    expect(dueUpdates).toEqual([]);

    await addNonWorkDayViaDialog(page, { label: 'Retreat', start: isoOffsetDays(wed) });
    await expect.poll(() => dueUpdates.length).toBe(1);
    await expect.poll(async () => (await bar.boundingBox())!.width).toBeCloseTo(4 * 28, 0);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Undone')).toHaveCount(0); // the toast action, not Ctrl+Z, so no extra toast
    await expect.poll(async () => (await bar.boundingBox())!.width).toBeCloseTo(3 * 28, 0);
    await expect.poll(() => dueUpdates.length).toBe(2);
    expect(dueUpdates[1]).toEqual({ id: 'uuid-211', dueDate: isoOffsetDays(wed) });

    // The manager lists both entries; removing one clears its shading
    await openNonWorkDaysDialog(page);
    const dialog = page.getByRole('dialog', { name: 'Holidays and PTO' });
    await expect(dialog.locator('[data-non-work-entry]')).toHaveCount(2);
    await expect(dialog.locator('[data-non-work-entry="Far Future"]')).toContainText(' – ');
    await dialog.getByRole('button', { name: 'Remove Retreat' }).click();
    await expect(dialog.locator('[data-non-work-entry="Retreat"]')).toHaveCount(0);
    await expect.poll(() => entries.map((e) => e.label)).toEqual(['Far Future']);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-non-work-day="Retreat"]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('validates the Holidays / PTO form before saving', async ({ page }) => {
    const errors = trackErrors(page);
    const mon = mondayOffset();
    await mockLinearIssues(page, [
      {
        id: 'uuid-221',
        identifier: 'ENG-221',
        title: 'Any task',
        assignee: 'Andrew Phillips',
        startOffset: mon,
        dueOffset: mon + 1,
      },
    ]);
    const entries = await mockNonWorkDayApi(page);

    await page.goto('/app');
    await expect(page.locator('[data-task-bar="ENG-221"]')).toBeVisible();
    await openNonWorkDaysDialog(page);
    const dialog = page.getByRole('dialog', { name: 'Holidays and PTO' });
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

  test('skips holidays and PTO when moving bars and counting workdays in the detail panel', async ({ page }) => {
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
        title: 'Spans PTO',
        assignee: 'Nate Jones',
        startOffset: mon,
        dueOffset: mon + 4,
      },
    ]);
    await mockNonWorkDayApi(page, [
      {
        id: 'h1',
        label: 'Company Retreat',
        startDate: isoOffsetDays(wed),
        endDate: isoOffsetDays(wed),
        assigneeName: null,
      },
      {
        id: 'p1',
        label: 'Nate PTO',
        startDate: isoOffsetDays(mon + 1),
        endDate: isoOffsetDays(mon + 1),
        assigneeName: 'Nate Jones',
      },
    ]);

    await page.goto('/app');
    const bar = page.locator('[data-task-bar="ENG-231"]');
    await expect(bar).toBeVisible();
    await expect(page.locator('tr[data-task-id="ENG-233"] [data-non-work-day="Nate PTO"]')).toHaveCount(1);

    // Duration in the detail panel excludes the holiday, and PTO only for Nate
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

  test('shares the holidays / PTO calendar through the server API', async ({ request, baseURL }) => {
    const origin = baseURL ?? 'http://127.0.0.1:4173';
    const headers = { origin, 'content-type': 'application/json' };
    const label = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const created = await request.post('/api/non-work-days', {
      headers,
      data: { label, startDate: '2099-11-26', endDate: '2099-11-27', assigneeName: 'Alex Rivera' },
    });
    expect(created.status()).toBe(201);
    const { nonWorkDay } = (await created.json()) as { nonWorkDay: NonWorkDayEntry };
    expect(nonWorkDay).toMatchObject({
      label,
      startDate: '2099-11-26',
      endDate: '2099-11-27',
      assigneeName: 'Alex Rivera',
    });

    try {
      const listed = await request.get('/api/non-work-days');
      expect(((await listed.json()) as { nonWorkDays: NonWorkDayEntry[] }).nonWorkDays).toContainEqual(nonWorkDay);

      const bad = await request.post('/api/non-work-days', { headers, data: { label, startDate: '2099-02-31' } });
      expect(bad.status()).toBe(400);
      const crossOrigin = await request.post('/api/non-work-days', {
        headers: { ...headers, origin: 'https://evil.example.com' },
        data: { label, startDate: '2099-11-26' },
      });
      expect(crossOrigin.status()).toBe(403);
    } finally {
      const removed = await request.delete(`/api/non-work-days/${nonWorkDay.id}`, { headers });
      expect(removed.status()).toBe(200);
    }
    const gone = await request.delete(`/api/non-work-days/${nonWorkDay.id}`, { headers });
    expect(gone.status()).toBe(404);
  });
});

/**
 * Mock a project with a two-level hierarchy:
 * ENG-200 (parent) > ENG-201 > ENG-203, ENG-200 > ENG-202, plus standalone ENG-210 and ENG-220.
 * ENG-201 blocks ENG-210 and ENG-202; ENG-202 blocks ENG-210.
 * The API's priority/due sort lists ENG-201 before its parent, so grouping has to pull it under ENG-200.
 */
async function mockSubtaskProject(page: Page) {
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
  );
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 200, body: '' }));
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

  const issue = (
    n: number,
    title: string,
    priority: number,
    dueInDays: number,
    assignee: string,
    parent: number | null,
    description = '',
  ) => ({
    id: `uuid-${n}`,
    identifier: `ENG-${n}`,
    title,
    description,
    dueDate: isoOffsetDays(dueInDays),
    url: `https://linear.app/bluecoreenergy/issue/ENG-${n}`,
    priority,
    state: { name: 'Todo', type: 'unstarted' },
    createdAt: '2026-01-01T00:00:00Z',
    completedAt: null,
    canceledAt: null,
    assignee: { name: assignee },
    team: { id: 'team-1' },
    projectMilestone: null,
    parent: parent === null ? null : { id: `uuid-${parent}`, identifier: `ENG-${parent}` },
  });
  const relation = (n: number, blocks: number[], blockedBy: number[], children: number[]) => ({
    id: `uuid-${n}`,
    identifier: `ENG-${n}`,
    relations: {
      nodes: [
        ...blocks.map((b) => ({ type: 'blocks', relatedIssue: { identifier: `ENG-${b}` } })),
        ...blockedBy.map((b) => ({ type: 'blocked_by', relatedIssue: { identifier: `ENG-${b}` } })),
      ],
    },
    children: {
      nodes: children.map((c) => ({
        id: `uuid-${c}`,
        completedAt: null,
        state: { name: 'Todo', type: 'unstarted' },
      })),
    },
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
      return respond({ projects: { nodes: [{ id: 'proj-1', name: 'Hierarchy Project' }] } });
    }
    if (query.includes('project(id:')) {
      return respond({
        project: {
          name: 'Hierarchy Project',
          startDate: isoOffsetDays(-5),
          targetDate: isoOffsetDays(30),
          projectMilestones: { nodes: [] },
          issues: {
            nodes: [
              issue(200, 'Valve program', 2, 12, 'Andrew Phillips', null, 'Valve program details'),
              issue(201, 'Valve seat design', 1, 4, 'Andrew Phillips', 200),
              issue(202, 'Valve needle test', 3, 8, 'Nate Jones', 200),
              issue(203, 'Needle calibration', 3, 9, 'Nate Jones', 201),
              issue(210, 'Commissioning plan', 2, 16, 'Nate Jones', null),
              issue(220, 'Urgent standalone', 1, 2, 'Andrew Phillips', null),
            ],
          },
          doneIssues: { nodes: [] },
        },
      });
    }
    if (query.includes('relations')) {
      return respond({
        issues: {
          nodes: [
            relation(200, [], [], [201, 202]),
            relation(201, [210, 202], [], [203]),
            relation(202, [210], [201], []),
            relation(203, [], [], []),
            relation(210, [], [201, 202], []),
            relation(220, [], [], []),
          ],
        },
      });
    }
    if (query.includes('workflowStates')) {
      return respond({
        workflowStates: { nodes: [{ id: 'st-1', name: 'Todo', type: 'unstarted', position: 0 }] },
      });
    }
    return route.fulfill({ status: 400, body: JSON.stringify({ errors: [{ message: 'Unexpected query' }] }) });
  });
}
