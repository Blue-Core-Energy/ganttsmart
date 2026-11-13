import { beforeEach, describe, expect, it, vi } from 'vitest';

const linearRequestMock = vi.fn();

vi.mock('@/backend', () => ({
  backend: {
    linearRequest: (...args: unknown[]) => linearRequestMock(...args),
  },
}));

import { fetchIssues } from './linear';

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeIssueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1',
    identifier: 'ENG-1',
    title: 'Active task',
    description: '',
    dueDate: '2026-11-20',
    url: 'https://linear.app/test/issue/ENG-1',
    priority: 2,
    state: { name: 'In Progress', type: 'started' },
    createdAt: '2026-11-01T00:00:00Z',
    completedAt: null,
    canceledAt: null,
    assignee: { name: 'Alice' },
    team: { id: 'team-1' },
    projectMilestone: null,
    ...overrides,
  };
}

describe('fetchIssues', () => {
  beforeEach(() => {
    linearRequestMock.mockReset();
  });

  it('requests canceledAt: { null: true } in GraphQL filters and ignores duplicate and canceled issues', async () => {
    const capturedQueries: Array<{ query: string; variables?: Record<string, unknown> }> = [];

    linearRequestMock.mockImplementation(
      async (_apiKey: string, body: { query: string; variables?: Record<string, unknown> }) => {
        capturedQueries.push(body);
        if (body.query.includes('project(id:')) {
          return jsonResponse({
            project: {
              name: 'GanttSmart',
              startDate: null,
              targetDate: null,
              projectMilestones: { nodes: [] },
              issues: {
                nodes: [
                  makeIssueNode({ id: 'uuid-1', identifier: 'ENG-1', title: 'Keep active' }),
                  makeIssueNode({
                    id: 'uuid-2',
                    identifier: 'ENG-2',
                    title: 'Duplicate by type',
                    state: { name: 'Duplicate', type: 'duplicate' },
                    canceledAt: '2026-11-02T00:00:00Z',
                  }),
                  makeIssueNode({
                    id: 'uuid-3',
                    identifier: 'ENG-3',
                    title: 'Canceled by type',
                    state: { name: 'Rejected', type: 'canceled' },
                    canceledAt: '2026-11-02T00:00:00Z',
                  }),
                  makeIssueNode({
                    id: 'uuid-4',
                    identifier: 'ENG-4',
                    title: 'Duplicate custom state without canceledAt',
                    dueDate: null,
                    state: { name: 'Duplicate', type: 'backlog' },
                    canceledAt: null,
                  }),
                  makeIssueNode({
                    id: 'uuid-5',
                    identifier: 'ENG-5',
                    title: 'Unscheduled active',
                    dueDate: null,
                    state: { name: 'Backlog', type: 'backlog' },
                  }),
                ],
              },
              doneIssues: {
                nodes: [
                  makeIssueNode({
                    id: 'uuid-6',
                    identifier: 'ENG-6',
                    title: 'Completed task',
                    state: { name: 'Done', type: 'completed' },
                    completedAt: '2026-11-05T00:00:00Z',
                  }),
                  makeIssueNode({
                    id: 'uuid-7',
                    identifier: 'ENG-7',
                    title: 'Done query leaked duplicate',
                    state: { name: 'Duplicate', type: 'duplicate' },
                    completedAt: '2026-11-05T00:00:00Z',
                  }),
                ],
              },
            },
          });
        }

        if (body.query.includes('relations')) {
          return jsonResponse({
            issues: {
              nodes: [
                {
                  id: 'uuid-1',
                  identifier: 'ENG-1',
                  relations: {
                    nodes: [
                      {
                        type: 'blocks',
                        relatedIssue: { identifier: 'ENG-2', state: { name: 'Duplicate', type: 'duplicate' } },
                      },
                      { type: 'blocks', relatedIssue: { identifier: 'ENG-3' } },
                      { type: 'blocks', relatedIssue: { identifier: 'ENG-5' } },
                      {
                        type: 'blocked_by',
                        relatedIssue: {
                          identifier: 'EXT-9',
                          canceledAt: '2026-11-01T00:00:00Z',
                          state: { name: 'Duplicate', type: 'duplicate' },
                        },
                      },
                    ],
                  },
                  children: {
                    nodes: [
                      {
                        id: 'c1',
                        completedAt: '2026-11-03T00:00:00Z',
                        canceledAt: null,
                        state: { name: 'Done', type: 'completed' },
                      },
                      { id: 'c2', completedAt: null, canceledAt: null, state: { name: 'Todo', type: 'unstarted' } },
                      {
                        id: 'c3',
                        completedAt: null,
                        canceledAt: '2026-11-03T00:00:00Z',
                        state: { name: 'Duplicate', type: 'duplicate' },
                      },
                      {
                        id: 'c4',
                        completedAt: null,
                        canceledAt: '2026-11-03T00:00:00Z',
                        state: { name: 'Canceled', type: 'canceled' },
                      },
                    ],
                  },
                },
                {
                  id: 'uuid-5',
                  identifier: 'ENG-5',
                  relations: {
                    nodes: [{ type: 'blocked_by', relatedIssue: { identifier: 'ENG-1' } }],
                  },
                  children: { nodes: [] },
                },
              ],
            },
          });
        }

        throw new Error(`Unexpected query: ${body.query}`);
      },
    );

    const result = await fetchIssues('token', 'proj-1');

    expect(capturedQueries[0].query).toContain('canceledAt: { null: true }');
    // Only non-ignored issue IDs should be fetched in Query 2
    expect(capturedQueries[1].variables).toEqual({ ids: ['uuid-1', 'uuid-5'] });

    expect(result.tasks.map((t) => t.id)).toEqual(['ENG-1']);
    expect(result.unscheduledTasks.map((t) => t.id)).toEqual(['ENG-5']);
    expect(result.doneTasks.map((t) => t.id)).toEqual(['ENG-6']);

    // Relations to ignored duplicate/canceled issues are stripped
    expect(result.tasks[0].blocks).toEqual(['ENG-5']);
    expect(result.tasks[0].blockedBy).toEqual([]);

    // Sub-issue progress ignores duplicate and canceled children (1 completed / 2 active = 50%)
    expect(result.tasks[0].totalChildren).toBe(2);
    expect(result.tasks[0].completedChildren).toBe(1);
    expect(result.tasks[0].progress).toBe(50);
  });

  it('ignores issues marked with an outgoing duplicate relation even if state is still unstarted', async () => {
    linearRequestMock.mockImplementation(async (_apiKey: string, body: { query: string }) => {
      if (body.query.includes('project(id:')) {
        return jsonResponse({
          project: {
            name: 'GanttSmart',
            startDate: null,
            targetDate: '2026-11-30',
            projectMilestones: { nodes: [] },
            issues: {
              nodes: [
                makeIssueNode({ id: 'uuid-1', identifier: 'ENG-1', title: 'Canonical issue' }),
                makeIssueNode({
                  id: 'uuid-2',
                  identifier: 'ENG-2',
                  title: 'Duplicate via relation',
                  state: { name: 'Todo', type: 'unstarted' },
                }),
              ],
            },
            doneIssues: { nodes: [] },
          },
        });
      }

      return jsonResponse({
        issues: {
          nodes: [
            {
              id: 'uuid-1',
              identifier: 'ENG-1',
              relations: {
                nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ENG-2' } }],
              },
              children: { nodes: [] },
            },
            {
              id: 'uuid-2',
              identifier: 'ENG-2',
              relations: {
                nodes: [{ type: 'duplicate', relatedIssue: { identifier: 'ENG-1' } }],
              },
              children: { nodes: [] },
            },
          ],
        },
      });
    });

    const result = await fetchIssues('token', 'proj-1');
    expect(result.tasks.map((t) => t.id)).toEqual(['ENG-1']);
    expect(result.tasks[0].blocks).toEqual([]);
    expect(result.unscheduledTasks).toEqual([]);
  });

  it('skips the relations query when all project issues are duplicate or canceled', async () => {
    linearRequestMock.mockResolvedValueOnce(
      jsonResponse({
        project: {
          name: 'Empty Project',
          startDate: null,
          targetDate: null,
          projectMilestones: { nodes: [] },
          issues: {
            nodes: [
              makeIssueNode({
                id: 'uuid-1',
                identifier: 'ENG-1',
                state: { name: 'Duplicate', type: 'duplicate' },
                canceledAt: '2026-11-02T00:00:00Z',
              }),
              makeIssueNode({
                id: 'uuid-2',
                identifier: 'ENG-2',
                state: { name: 'Canceled', type: 'canceled' },
                canceledAt: '2026-11-02T00:00:00Z',
              }),
            ],
          },
          doneIssues: { nodes: [] },
        },
      }),
    );

    const result = await fetchIssues('token', 'proj-1');
    expect(linearRequestMock).toHaveBeenCalledTimes(1);
    expect(result.tasks).toEqual([]);
    expect(result.unscheduledTasks).toEqual([]);
    expect(result.doneTasks).toEqual([]);
  });
});
