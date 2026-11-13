import { beforeEach, describe, expect, it, vi } from 'vitest';

const { linearRequestMock } = vi.hoisted(() => ({
  linearRequestMock: vi.fn(),
}));

vi.mock('@/backend', () => ({
  backend: {
    linearRequest: linearRequestMock,
  },
}));

import {
  GANTT_LINK_LABEL,
  createFeedbackIssue,
  createProjectExternalLink,
  FeedbackTargetNotFoundError,
  fetchIssues,
  fetchProjectExternalLinks,
  findActiveExternalLink,
  resolveFeedbackTarget,
} from './linear';

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

  it('requests canceledAt: { null: true } in GraphQL filters, ignores duplicate/canceled issues, and unifies completed issues', async () => {
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
                {
                  id: 'uuid-6',
                  identifier: 'ENG-6',
                  relations: { nodes: [] },
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
    // Only non-ignored issue IDs (active + completed) should be fetched in Query 2
    expect(capturedQueries[1].variables).toEqual({ ids: ['uuid-1', 'uuid-5', 'uuid-6'] });

    expect(result.tasks.map((t) => t.id)).toEqual(['ENG-1', 'ENG-6']);
    expect(result.unscheduledTasks.map((t) => t.id)).toEqual(['ENG-5']);

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
  });

  it('unifies scheduled completed tasks into tasks and fetches relations/children for them', async () => {
    linearRequestMock.mockImplementation(
      async (_token: string, body: { query: string; variables?: Record<string, unknown> }) => {
        if (body.query.includes('project(id:')) {
          return jsonResponse({
            project: {
              name: 'Unified Project',
              startDate: '2026-05-01',
              targetDate: '2026-05-30',
              projectMilestones: { nodes: [] },
              issues: {
                nodes: [
                  makeIssueNode({
                    id: 'uuid-active',
                    identifier: 'ENG-2',
                    title: 'Active work',
                    description: 'start: 05-05-26',
                    dueDate: '2026-05-12',
                    url: 'https://linear.app/test/ENG-2',
                    priority: 2,
                    state: { name: 'In Progress', type: 'started' },
                    createdAt: '2026-05-01T00:00:00Z',
                  }),
                ],
              },
              doneIssues: {
                nodes: [
                  makeIssueNode({
                    id: 'uuid-done',
                    identifier: 'ENG-1',
                    title: 'Done work',
                    description: 'start: 01-05-26',
                    dueDate: '2026-05-04',
                    url: 'https://linear.app/test/ENG-1',
                    priority: 1,
                    state: { name: 'Done', type: 'completed' },
                    createdAt: '2026-04-28T00:00:00Z',
                    completedAt: '2026-05-04T12:00:00Z',
                    assignee: { name: 'Bob' },
                  }),
                ],
              },
            },
          });
        }

        if (body.query.includes('relations')) {
          expect(body.variables?.ids).toEqual(['uuid-active', 'uuid-done']);
          return jsonResponse({
            issues: {
              nodes: [
                {
                  id: 'uuid-done',
                  identifier: 'ENG-1',
                  relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ENG-2' } }] },
                  children: {
                    nodes: [
                      {
                        id: 'c1',
                        completedAt: '2026-05-03T00:00:00Z',
                        canceledAt: null,
                        state: { name: 'Done', type: 'completed' },
                      },
                    ],
                  },
                },
                {
                  id: 'uuid-active',
                  identifier: 'ENG-2',
                  relations: { nodes: [{ type: 'blocked_by', relatedIssue: { identifier: 'ENG-1' } }] },
                  children: { nodes: [] },
                },
              ],
            },
          });
        }

        throw new Error(`Unexpected query: ${body.query}`);
      },
    );

    const result = await fetchIssues('tok', 'proj-1');
    expect(result.projectName).toBe('Unified Project');
    expect(result.unscheduledTasks).toEqual([]);
    expect(result.tasks.map((t) => t.id)).toEqual(['ENG-1', 'ENG-2']);
    expect(result.tasks[0]).toMatchObject({
      id: 'ENG-1',
      statusType: 'completed',
      blocks: ['ENG-2'],
      totalChildren: 1,
      completedChildren: 1,
      progress: 100,
    });
    expect(result.tasks[1]).toMatchObject({
      id: 'ENG-2',
      statusType: 'started',
      blockedBy: ['ENG-1'],
    });
  });

  it('omits completed tasks that have neither dueDate nor project targetDate', async () => {
    linearRequestMock.mockImplementation(async (_token: string, body: { query: string }) => {
      if (body.query.includes('project(id:')) {
        return jsonResponse({
          project: {
            name: 'No Target Project',
            startDate: null,
            targetDate: null,
            projectMilestones: { nodes: [] },
            issues: { nodes: [] },
            doneIssues: {
              nodes: [
                makeIssueNode({
                  id: 'uuid-done-undated',
                  identifier: 'ENG-9',
                  title: 'Undated done',
                  description: null,
                  dueDate: null,
                  url: 'https://linear.app/test/ENG-9',
                  priority: 2,
                  state: { name: 'Done', type: 'completed' },
                  createdAt: '2026-05-01T00:00:00Z',
                  completedAt: '2026-05-02T00:00:00Z',
                  assignee: null,
                }),
              ],
            },
          },
        });
      }
      return jsonResponse({ issues: { nodes: [] } });
    });

    const result = await fetchIssues('tok', 'proj-2');
    expect(result.tasks).toEqual([]);
    expect(result.unscheduledTasks).toEqual([]);
  });
});

describe('resolveFeedbackTarget', () => {
  beforeEach(() => {
    linearRequestMock.mockReset();
  });

  it('resolves GanttSmart project, IT team, and Feature/Bug labels', async () => {
    linearRequestMock.mockResolvedValueOnce(
      jsonResponse({
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
      }),
    );

    const target = await resolveFeedbackTarget('tok');
    expect(target).toEqual({
      teamId: '2e7232fc-d509-4471-9922-e5f8c89459d3',
      teamKey: 'IT',
      teamName: 'IT',
      projectId: '0ac0d58d-1852-4d27-9fbc-944cabc5b492',
      projectName: 'GanttSmart',
      projectUrl: 'https://linear.app/bluecoreenergy/project/ganttsmart-5114378da6de',
      labelIds: {
        feature: '6ef1fd41-af6d-48ec-ae08-2a529cfc0013',
        bug: '79878471-e70d-405d-83b7-a50dd8a853fe',
      },
    });
  });

  it('falls back to top-level IT team and workspace issueLabels when project teams lack labels', async () => {
    linearRequestMock.mockResolvedValueOnce(
      jsonResponse({
        projects: {
          nodes: [
            {
              id: 'proj-gs',
              name: 'ganttsmart',
              url: null,
              slugId: '5114378da6de',
              teams: { nodes: [] },
            },
          ],
        },
        teams: {
          nodes: [
            { id: 'team-eng', key: 'ENG', name: 'Engineering', labels: { nodes: [] } },
            { id: 'team-it', key: 'IT', name: 'IT', labels: { nodes: [] } },
          ],
        },
        issueLabels: {
          nodes: [
            { id: 'lbl-feat-ws', name: 'feature', team: null },
            { id: 'lbl-bug-other', name: 'Bug', team: { id: 'team-eng' } },
            { id: 'lbl-bug-it', name: 'Bug', team: { id: 'team-it' } },
          ],
        },
      }),
    );

    const target = await resolveFeedbackTarget('tok');
    expect(target.teamId).toBe('team-it');
    expect(target.projectId).toBe('proj-gs');
    expect(target.labelIds).toEqual({
      feature: 'lbl-feat-ws',
      bug: 'lbl-bug-it',
    });
  });

  it('supports VITE_FEEDBACK_PROJECT_URL and VITE_FEEDBACK_TEAM_KEY overrides and project leadTeam fallback', async () => {
    linearRequestMock.mockResolvedValueOnce(
      jsonResponse({
        projects: {
          nodes: [
            {
              id: 'proj-custom',
              name: 'Custom Tracker',
              url: 'https://linear.app/acme/project/custom-tracker-abc999',
              slugId: 'abc999',
              teams: {
                nodes: [
                  {
                    id: 'team-ops',
                    key: 'OPS',
                    name: 'Operations',
                    labels: {
                      nodes: [{ id: 'lbl-bug-ops', name: 'Bug' }],
                    },
                  },
                ],
              },
            },
          ],
        },
        teams: { nodes: [] },
        issueLabels: { nodes: [] },
      }),
    );

    const target = await resolveFeedbackTarget('tok', {
      VITE_FEEDBACK_PROJECT_URL: 'https://linear.app/acme/project/custom-tracker-abc999',
      VITE_FEEDBACK_TEAM_KEY: 'OPS',
    });

    expect(target.projectId).toBe('proj-custom');
    expect(target.teamId).toBe('team-ops');
    expect(target.teamKey).toBe('OPS');
    expect(target.labelIds).toEqual({ feature: undefined, bug: 'lbl-bug-ops' });
  });

  it('throws FeedbackTargetNotFoundError when the workspace has no GanttSmart project', async () => {
    linearRequestMock.mockResolvedValueOnce(
      jsonResponse({
        projects: {
          nodes: [{ id: 'proj-other', name: 'Completely Different Project', teams: { nodes: [] } }],
        },
        teams: {
          nodes: [{ id: 'team-eng', key: 'ENG', name: 'Engineering', labels: { nodes: [] } }],
        },
        issueLabels: { nodes: [] },
      }),
    );

    await expect(resolveFeedbackTarget('tok')).rejects.toBeInstanceOf(FeedbackTargetNotFoundError);
  });
});

describe('createFeedbackIssue', () => {
  beforeEach(() => {
    linearRequestMock.mockReset();
  });

  it('creates a Feature Request issue with resolved team, project, and Feature label', async () => {
    const capturedCalls: Array<{ query: string; variables?: Record<string, unknown> }> = [];

    linearRequestMock.mockImplementation(
      async (_apiKey: string, body: { query: string; variables?: Record<string, unknown> }) => {
        capturedCalls.push(body);
        if (body.query.includes('FeedbackTarget')) {
          return jsonResponse({
            projects: {
              nodes: [
                {
                  id: 'proj-gs',
                  name: 'GanttSmart',
                  url: 'https://linear.app/bluecoreenergy/project/ganttsmart-5114378da6de',
                  slugId: '5114378da6de',
                  teams: {
                    nodes: [
                      {
                        id: 'team-it',
                        key: 'IT',
                        name: 'IT',
                        labels: {
                          nodes: [
                            { id: 'lbl-feature', name: 'Feature' },
                            { id: 'lbl-bug', name: 'Bug' },
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
          });
        }

        if (body.query.includes('issueCreate')) {
          return jsonResponse({
            issueCreate: {
              success: true,
              issue: {
                id: 'issue-uuid-1',
                identifier: 'IT-99',
                title: 'Add CSV export',
                url: 'https://linear.app/bluecoreenergy/issue/IT-99',
              },
            },
          });
        }

        throw new Error(`Unexpected query: ${body.query}`);
      },
    );

    const created = await createFeedbackIssue({
      apiKey: 'tok',
      type: 'feature',
      title: '  Add CSV export  ',
      description: '### What would help?\nExport milestones to CSV.',
    });

    expect(created).toEqual({
      id: 'issue-uuid-1',
      identifier: 'IT-99',
      title: 'Add CSV export',
      url: 'https://linear.app/bluecoreenergy/issue/IT-99',
    });

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[1].variables).toEqual({
      input: {
        teamId: 'team-it',
        projectId: 'proj-gs',
        title: 'Add CSV export',
        description: '### What would help?\nExport milestones to CSV.',
        labelIds: ['lbl-feature'],
      },
    });
  });

  it('creates a Bug Report issue without optional labelIds or description when omitted', async () => {
    const capturedCalls: Array<{ query: string; variables?: Record<string, unknown> }> = [];

    linearRequestMock.mockImplementation(
      async (_apiKey: string, body: { query: string; variables?: Record<string, unknown> }) => {
        capturedCalls.push(body);
        if (body.query.includes('FeedbackTarget')) {
          return jsonResponse({
            projects: {
              nodes: [
                {
                  id: 'proj-gs',
                  name: 'GanttSmart',
                  teams: {
                    nodes: [{ id: 'team-it', key: 'IT', name: 'IT', labels: { nodes: [] } }],
                  },
                },
              ],
            },
            teams: { nodes: [] },
            issueLabels: { nodes: [] },
          });
        }
        return jsonResponse({
          issueCreate: {
            success: true,
            issue: {
              id: 'issue-uuid-2',
              identifier: 'IT-100',
              title: 'Drag glitch',
              url: 'https://linear.app/bluecoreenergy/issue/IT-100',
            },
          },
        });
      },
    );

    const created = await createFeedbackIssue({
      apiKey: 'tok',
      type: 'bug',
      title: 'Drag glitch',
      description: '   ',
    });

    expect(created.identifier).toBe('IT-100');
    expect(capturedCalls[1].variables).toEqual({
      input: {
        teamId: 'team-it',
        projectId: 'proj-gs',
        title: 'Drag glitch',
      },
    });
  });

  it('rejects empty titles and unconfirmed Linear mutations', async () => {
    await expect(
      createFeedbackIssue({
        apiKey: 'tok',
        type: 'feature',
        title: '   ',
        description: '',
      }),
    ).rejects.toThrow('Title is required');

    linearRequestMock.mockResolvedValueOnce(
      jsonResponse({
        projects: {
          nodes: [
            {
              id: 'proj-gs',
              name: 'GanttSmart',
              teams: { nodes: [{ id: 'team-it', key: 'IT', name: 'IT', labels: { nodes: [] } }] },
            },
          ],
        },
        teams: { nodes: [] },
        issueLabels: { nodes: [] },
      }),
    );
    linearRequestMock.mockResolvedValueOnce(
      jsonResponse({
        issueCreate: { success: false, issue: null },
      }),
    );

    await expect(
      createFeedbackIssue({
        apiKey: 'tok',
        type: 'bug',
        title: 'Broken bar',
        description: 'Details',
      }),
    ).rejects.toThrow('Linear did not confirm issue creation.');
  });
});

describe('Linear project external links', () => {
  beforeEach(() => {
    linearRequestMock.mockReset();
  });

  it('fetchProjectExternalLinks returns project url and filters out archived links', async () => {
    linearRequestMock.mockResolvedValueOnce(
      jsonResponse({
        project: {
          url: 'https://linear.app/bluecoreenergy/project/beta-mobile-proj-2',
          externalLinks: {
            nodes: [
              {
                id: 'link-1',
                label: GANTT_LINK_LABEL,
                url: 'https://gantt.example.com/app?project=proj-2',
                archivedAt: null,
              },
              {
                id: 'link-2',
                label: 'Old link',
                url: 'https://gantt.example.com/app?project=proj-2',
                archivedAt: '2026-01-01T00:00:00Z',
              },
            ],
          },
        },
      }),
    );

    const result = await fetchProjectExternalLinks('tok', 'proj-2');
    expect(result).toEqual({
      url: 'https://linear.app/bluecoreenergy/project/beta-mobile-proj-2',
      externalLinks: [
        {
          id: 'link-1',
          label: GANTT_LINK_LABEL,
          url: 'https://gantt.example.com/app?project=proj-2',
          archivedAt: null,
        },
      ],
    });
  });

  it('createProjectExternalLink creates a new link when none exists for the target URL', async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    linearRequestMock.mockImplementation(
      async (_token: string, body: { query: string; variables?: Record<string, unknown> }) => {
        calls.push(body);
        if (body.query.includes('externalLinks')) {
          return jsonResponse({
            project: {
              url: 'https://linear.app/bluecoreenergy/project/beta-mobile-proj-2',
              externalLinks: {
                nodes: [
                  // Archived link with same URL should not block creating an active link
                  {
                    id: 'archived-1',
                    label: GANTT_LINK_LABEL,
                    url: 'https://gantt.example.com/app?project=proj-2',
                    archivedAt: '2026-01-01T00:00:00Z',
                  },
                  // Active link for a different origin should not block creating one for this origin
                  {
                    id: 'other-origin',
                    label: GANTT_LINK_LABEL,
                    url: 'http://localhost:5173/app?project=proj-2',
                    archivedAt: null,
                  },
                ],
              },
            },
          });
        }
        if (body.query.includes('entityExternalLinkCreate')) {
          return jsonResponse({
            entityExternalLinkCreate: {
              success: true,
              entityExternalLink: {
                id: 'new-link-1',
                label: GANTT_LINK_LABEL,
                url: 'https://gantt.example.com/app?project=proj-2',
              },
            },
          });
        }
        throw new Error(`Unexpected query: ${body.query}`);
      },
    );

    const res = await createProjectExternalLink('tok', 'proj-2', 'https://gantt.example.com');
    expect(res).toEqual({
      created: true,
      projectUrl: 'https://linear.app/bluecoreenergy/project/beta-mobile-proj-2',
      link: {
        id: 'new-link-1',
        label: GANTT_LINK_LABEL,
        url: 'https://gantt.example.com/app?project=proj-2',
        archivedAt: null,
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].variables).toEqual({
      input: {
        projectId: 'proj-2',
        url: 'https://gantt.example.com/app?project=proj-2',
        label: GANTT_LINK_LABEL,
      },
    });
  });

  it('createProjectExternalLink avoids duplicate creation when an active link with the same URL exists', async () => {
    linearRequestMock.mockResolvedValueOnce(
      jsonResponse({
        project: {
          url: 'https://linear.app/bluecoreenergy/project/beta-mobile-proj-2',
          externalLinks: {
            nodes: [
              {
                id: 'existing-1',
                label: 'Existing GanttSmart Link',
                url: 'https://gantt.example.com/app?project=proj-2',
                archivedAt: null,
              },
            ],
          },
        },
      }),
    );

    const res = await createProjectExternalLink('tok', 'proj-2', 'https://gantt.example.com');
    expect(res).toEqual({
      created: false,
      projectUrl: 'https://linear.app/bluecoreenergy/project/beta-mobile-proj-2',
      link: {
        id: 'existing-1',
        label: 'Existing GanttSmart Link',
        url: 'https://gantt.example.com/app?project=proj-2',
        archivedAt: null,
      },
    });
    expect(linearRequestMock).toHaveBeenCalledTimes(1);
  });

  it('createProjectExternalLink throws when entityExternalLinkCreate returns success: false', async () => {
    linearRequestMock
      .mockResolvedValueOnce(
        jsonResponse({
          project: { url: null, externalLinks: { nodes: [] } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          entityExternalLinkCreate: { success: false, entityExternalLink: null },
        }),
      );

    await expect(createProjectExternalLink('tok', 'proj-2', 'https://gantt.example.com')).rejects.toThrow(
      'Could not create external link on Linear project',
    );
  });

  it('findActiveExternalLink ignores archived links and matches normalized URLs', () => {
    expect(
      findActiveExternalLink(
        [
          {
            id: '1',
            label: 'Archived',
            url: 'https://gantt.example.com/app?project=proj-2',
            archivedAt: '2026-01-01T00:00:00Z',
          },
          {
            id: '2',
            label: 'Active',
            url: 'https://gantt.example.com/app?project=proj-2',
            archivedAt: null,
          },
        ],
        'https://gantt.example.com/app?project=proj-2',
      )?.id,
    ).toBe('2');
  });
});
