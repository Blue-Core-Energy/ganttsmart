import type { Page } from '@playwright/test';
import { isoOffsetDays, startTagOffsetDays } from './dates.js';
import { createScheduleMock, type ScheduleMock } from './scheduleMock.js';

export interface MockIssue {
  id: string;
  identifier: string;
  title: string;
  assignee: string;
  startOffset: number;
  dueOffset: number;
}

/** Mocks Linear for one project; returns the due-date and start-date updates the app sends, by issue id. */
export async function mockLinearIssues(page: Page, issues: MockIssue[]) {
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

/**
 * Mock a project with a two-level hierarchy:
 * ENG-200 (parent) > ENG-201 > ENG-203, ENG-200 > ENG-202, plus standalone ENG-210 and ENG-220.
 * ENG-201 blocks ENG-210 and ENG-202; ENG-202 blocks ENG-210.
 * The API's priority/due sort lists ENG-201 before its parent, so grouping has to pull it under ENG-200.
 */
export async function mockSubtaskProject(page: Page, scheduleMock: ScheduleMock = createScheduleMock()) {
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
    if (await scheduleMock.handle(route, payload)) return;
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
