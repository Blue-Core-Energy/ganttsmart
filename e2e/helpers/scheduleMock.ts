import type { Route } from '@playwright/test';

export interface MockScheduleComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Mocks the GanttSmart schedule-comment GraphQL operations: the batched `ScheduleComments` read,
 * the per-issue `IssueSchedule` read, `commentCreate` and `commentUpdate`.
 */
export function createScheduleMock(initial: { description?: string | null; dueDate?: string | null } = {}) {
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
    if (query.includes('commentDelete')) {
      const id = String(variables.id ?? '');
      state.comments = state.comments.filter((c) => c.id !== id);
      await respond(route, { commentDelete: { success: true } });
      return true;
    }
    return false;
  }

  return { state, handle };
}

export type ScheduleMock = ReturnType<typeof createScheduleMock>;
