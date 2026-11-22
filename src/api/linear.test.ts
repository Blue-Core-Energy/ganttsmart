import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { linearRequestMock } = vi.hoisted(() => ({
  linearRequestMock: vi.fn(),
}));

vi.mock('@/backend', () => ({
  backend: {
    linearRequest: linearRequestMock,
  },
}));

import {
  FEEDBACK_TARGET_QUERY,
  GANTT_LINK_LABEL,
  ISSUE_SCHEDULE_QUERY,
  SCHEDULE_COMMENTS_PER_ISSUE,
  SCHEDULE_COMMENTS_QUERY,
  SCHEDULE_COMMENT_BATCH_SIZE,
  formatScheduleComment,
  parseScheduleComment,
  parseStartDate,
  pickScheduleComment,
  resolveIssueSchedule,
  updateIssueDueDate,
  updateIssueStartDate,
  createFeedbackIssue,
  createProjectExternalLink,
  FeedbackTargetNotFoundError,
  fetchIssues,
  fetchProjectExternalLinks,
  fetchWorkflowStates,
  findActiveExternalLink,
  isRetryableNetworkError,
  resolveFeedbackTarget,
  testAuth,
  updateIssueState,
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

  it('extracts cross-project dependencies from Query 2 without extra requests and deduplicates shared blockers', async () => {
    const queries: string[] = [];
    linearRequestMock.mockImplementation(async (_token: string, body: { query: string }) => {
      queries.push(body.query);
      if (body.query.includes('project(id:')) {
        return jsonResponse({
          project: {
            name: 'Commissioning',
            startDate: '2026-05-01',
            targetDate: '2026-06-01',
            projectMilestones: { nodes: [] },
            issues: {
              nodes: [
                makeIssueNode({ id: 'uuid-1', identifier: 'COMM-1', title: 'Loop check', dueDate: '2026-05-20' }),
                makeIssueNode({ id: 'uuid-2', identifier: 'COMM-2', title: 'Pressure test', dueDate: '2026-05-25' }),
              ],
            },
            doneIssues: { nodes: [] },
          },
        });
      }

      if (body.query.includes('ScheduleComments')) {
        return jsonResponse({ issues: { nodes: [] } });
      }

      return jsonResponse({
        issues: {
          nodes: [
            {
              id: 'uuid-1',
              identifier: 'COMM-1',
              relations: {
                nodes: [
                  {
                    type: 'blocked_by',
                    relatedIssue: {
                      id: 'ext-ctrl-1',
                      identifier: 'CTRL-42',
                      title: 'Wire PLC panel',
                      description: 'start: 02-05-26',
                      dueDate: '2026-05-15',
                      url: 'https://linear.app/test/CTRL-42',
                      priority: 1,
                      completedAt: null,
                      canceledAt: null,
                      state: { name: 'In Progress', type: 'started' },
                      assignee: { name: 'Carol' },
                      team: { id: 'team-ctrl' },
                      project: { id: 'proj-ctrl', name: 'Controls', targetDate: '2026-05-30' },
                    },
                  },
                  {
                    // Same-project unscheduled/known issue should never be duplicated as external
                    type: 'blocks',
                    relatedIssue: {
                      id: 'uuid-2',
                      identifier: 'COMM-2',
                      title: 'Pressure test',
                      project: { id: 'proj-1', name: 'Commissioning', targetDate: '2026-06-01' },
                    },
                  },
                ],
              },
              children: { nodes: [] },
            },
            {
              id: 'uuid-2',
              identifier: 'COMM-2',
              relations: {
                nodes: [
                  {
                    // Same external blocker linked to second local issue — deduplicated
                    type: 'blocked_by',
                    relatedIssue: {
                      id: 'ext-ctrl-1',
                      identifier: 'CTRL-42',
                      title: 'Wire PLC panel',
                      description: 'start: 02-05-26',
                      dueDate: '2026-05-15',
                      url: 'https://linear.app/test/CTRL-42',
                      priority: 1,
                      completedAt: null,
                      canceledAt: null,
                      state: { name: 'In Progress', type: 'started' },
                      assignee: { name: 'Carol' },
                      team: { id: 'team-ctrl' },
                      project: { id: 'proj-ctrl', name: 'Controls', targetDate: '2026-05-30' },
                    },
                  },
                  {
                    // External issue with no dueDate falls back to its project.targetDate (isDueImplicit)
                    type: 'blocks',
                    relatedIssue: {
                      id: 'ext-ops-1',
                      identifier: 'OPS-7',
                      title: 'Site handover',
                      description: null,
                      dueDate: null,
                      url: 'https://linear.app/test/OPS-7',
                      priority: 3,
                      completedAt: null,
                      canceledAt: null,
                      state: { name: 'Todo', type: 'unstarted' },
                      assignee: null,
                      team: { id: 'team-ops' },
                      project: { id: 'proj-ops', name: 'Operations', targetDate: '2026-06-10' },
                    },
                  },
                  {
                    // Unscheduled external issue (no dueDate and no project targetDate)
                    type: 'blocked_by',
                    relatedIssue: {
                      id: 'ext-unsched',
                      identifier: 'CTRL-99',
                      title: 'Undated sensor check',
                      description: null,
                      dueDate: null,
                      url: 'https://linear.app/test/CTRL-99',
                      priority: 4,
                      completedAt: null,
                      canceledAt: null,
                      state: { name: 'Backlog', type: 'backlog' },
                      assignee: null,
                      team: { id: 'team-ctrl' },
                      project: { id: 'proj-ctrl', name: 'Controls', targetDate: null },
                    },
                  },
                  {
                    // Canceled external issue should be ignored completely
                    type: 'blocked_by',
                    relatedIssue: {
                      id: 'ext-canceled',
                      identifier: 'CTRL-88',
                      title: 'Canceled task',
                      canceledAt: '2026-05-01T00:00:00Z',
                      state: { name: 'Canceled', type: 'canceled' },
                      project: { id: 'proj-ctrl', name: 'Controls', targetDate: '2026-05-30' },
                    },
                  },
                ],
              },
              children: { nodes: [] },
            },
          ],
        },
      });
    });

    const result = await fetchIssues('tok', 'proj-1');
    // project query, relations/children query, then one schedule-comments batch (local + external issues)
    expect(linearRequestMock).toHaveBeenCalledTimes(3);
    expect(queries[1]).toContain('project {');
    expect(queries[2]).toContain('ScheduleComments');

    expect(result.externalTasks).toHaveLength(2);
    expect(result.externalTasks[0]).toMatchObject({
      id: 'CTRL-42',
      uuid: 'ext-ctrl-1',
      isExternal: true,
      projectId: 'proj-ctrl',
      projectName: 'Controls',
      startDate: '2026-05-02',
      due: '2026-05-15',
      blocks: ['COMM-1', 'COMM-2'],
      blockedBy: [],
      teamId: 'team-ctrl',
    });
    expect(result.externalTasks[0].isDueImplicit).toBeUndefined();

    expect(result.externalTasks[1]).toMatchObject({
      id: 'OPS-7',
      uuid: 'ext-ops-1',
      isExternal: true,
      projectId: 'proj-ops',
      projectName: 'Operations',
      due: '2026-06-10',
      isDueImplicit: true,
      blocks: [],
      blockedBy: ['COMM-2'],
    });

    expect(result.externalUnscheduledTasks).toHaveLength(1);
    expect(result.externalUnscheduledTasks[0]).toMatchObject({
      id: 'CTRL-99',
      isExternal: true,
      isUnscheduledExternal: true,
      projectName: 'Controls',
      blocks: ['COMM-2'],
    });
    expect(result.tasks.find((t) => t.id === 'COMM-2')?.blockedBy).toEqual(['CTRL-42', 'CTRL-99']);
  });
});

/**
 * Estimate static GraphQL query complexity using Linear's documented rules:
 * - scalar field: 0.1
 * - object field: 1 + children
 * - paginated connection (has `nodes { ... }`): `first` (default 50) * node cost
 */
function estimateLinearQueryComplexity(query: string): number {
  const tokens: string[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < query.length && query[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < query.length && query[i] !== '"') {
        if (query[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')') {
      tokens.push(ch);
      i++;
      continue;
    }
    let j = i;
    while (j < query.length && !/[\s,{}()#"]/.test(query[j])) j++;
    tokens.push(query.slice(i, j));
    i = j;
  }

  let pos = 0;
  if (tokens[pos] === 'query' || tokens[pos] === 'mutation') {
    pos++;
    if (tokens[pos] && tokens[pos] !== '{' && tokens[pos] !== '(') pos++;
    if (tokens[pos] === '(') {
      let depth = 1;
      pos++;
      while (pos < tokens.length && depth > 0) {
        if (tokens[pos] === '(') depth++;
        else if (tokens[pos] === ')') depth--;
        pos++;
      }
    }
  }

  function parseSelectionSet(): { cost: number; hasNodes: boolean; nodesCost: number } {
    pos++; // consume '{'
    let cost = 0;
    let hasNodes = false;
    let nodesCost = 0;

    while (pos < tokens.length && tokens[pos] !== '}') {
      const name = tokens[pos++];
      // Skip alias if present (`alias: field`)
      const fieldName = name.endsWith(':') ? tokens[pos++] : name;
      let firstArg: number | null = null;

      if (tokens[pos] === '(') {
        let depth = 1;
        pos++;
        const argTokens: string[] = [];
        while (pos < tokens.length && depth > 0) {
          const t = tokens[pos++];
          if (t === '(') depth++;
          else if (t === ')') {
            depth--;
            if (depth === 0) break;
          }
          argTokens.push(t);
        }
        const firstMatch = /\b(?:first|last):\s*(\d+)\b/.exec(argTokens.join(' '));
        if (firstMatch) {
          firstArg = Number(firstMatch[1]);
        }
      }

      if (tokens[pos] === '{') {
        const sub = parseSelectionSet();
        if (fieldName === 'nodes') {
          hasNodes = true;
          nodesCost = 1 + sub.cost;
        } else if (sub.hasNodes) {
          cost += 1 + (firstArg ?? 50) * sub.nodesCost;
        } else {
          cost += 1 + sub.cost;
        }
      } else {
        cost += 0.1;
      }
    }
    pos++; // consume '}'
    return { cost, hasNodes, nodesCost };
  }

  return Math.ceil(parseSelectionSet().cost);
}

describe('FEEDBACK_TARGET_QUERY complexity', () => {
  it('stays well below Linear 10,000 single-query complexity limit without nested label connections', () => {
    expect(FEEDBACK_TARGET_QUERY).not.toMatch(/\blabels\s*\(/);
    expect(FEEDBACK_TARGET_QUERY).toContain('eqIgnoreCase: "feature"');
    expect(FEEDBACK_TARGET_QUERY).toContain('eqIgnoreCase: "bug"');

    const complexity = estimateLinearQueryComplexity(FEEDBACK_TARGET_QUERY);
    expect(complexity).toBeLessThan(4000);
    expect(complexity).toBeLessThan(10000);
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

  it('falls back to top-level IT team and workspace issueLabels, ignoring groups and preferring team labels', async () => {
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
            { id: 'team-eng', key: 'ENG', name: 'Engineering' },
            { id: 'team-it', key: 'IT', name: 'IT' },
          ],
        },
        issueLabels: {
          nodes: [
            { id: 'lbl-feat-group', name: 'Feature', isGroup: true, team: { id: 'team-it' } },
            { id: 'lbl-feat-ws', name: 'feature', isGroup: false, team: null },
            { id: 'lbl-bug-ws', name: 'Bug', isGroup: false, team: null },
            { id: 'lbl-bug-other', name: 'Bug', isGroup: false, team: { id: 'team-eng' } },
            { id: 'lbl-bug-it', name: 'Bug', isGroup: false, team: { id: 'team-it' } },
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
                  },
                ],
              },
            },
          ],
        },
        teams: { nodes: [] },
        issueLabels: {
          nodes: [{ id: 'lbl-bug-ops', name: 'Bug', isGroup: false, team: { id: 'team-ops' } }],
        },
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
          nodes: [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }],
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
                      },
                    ],
                  },
                },
              ],
            },
            teams: { nodes: [] },
            issueLabels: {
              nodes: [
                { id: 'lbl-feature', name: 'Feature', isGroup: false, team: { id: 'team-it' } },
                { id: 'lbl-bug', name: 'Bug', isGroup: false, team: { id: 'team-it' } },
              ],
            },
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
                    nodes: [{ id: 'team-it', key: 'IT', name: 'IT' }],
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
              teams: { nodes: [{ id: 'team-it', key: 'IT', name: 'IT' }] },
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

describe('workflowStates & updateIssueState', () => {
  beforeEach(() => {
    linearRequestMock.mockReset();
  });

  it('fetchWorkflowStates declares $teamId as ID! and sorts nodes by position', async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    linearRequestMock.mockImplementation(
      async (_token: string, body: { query: string; variables?: Record<string, unknown> }) => {
        calls.push(body);
        return jsonResponse({
          workflowStates: {
            nodes: [
              { id: 'st-3', name: 'Done', type: 'completed', position: 2 },
              { id: 'st-1', name: 'Todo', type: 'unstarted', position: 0 },
              { id: 'st-2', name: 'In Progress', type: 'started', position: 1 },
            ],
          },
        });
      },
    );

    const states = await fetchWorkflowStates('tok', 'team-1');
    expect(calls[0].query).toContain('$teamId: ID!');
    expect(calls[0].query).toContain('first: 100');
    expect(calls[0].variables).toEqual({ teamId: 'team-1' });
    expect(states.map((s) => s.id)).toEqual(['st-1', 'st-2', 'st-3']);
  });

  it('updateIssueState sends issueUpdate mutation and throws when success is false', async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    linearRequestMock.mockImplementation(
      async (_token: string, body: { query: string; variables?: Record<string, unknown> }) => {
        calls.push(body);
        return jsonResponse({ issueUpdate: { success: true } });
      },
    );

    await updateIssueState('tok', 'uuid-1', 'st-2');
    expect(calls[0].query).toContain('issueUpdate');
    expect(calls[0].variables).toEqual({ id: 'uuid-1', stateId: 'st-2' });

    linearRequestMock.mockResolvedValueOnce(jsonResponse({ issueUpdate: { success: false } }));
    await expect(updateIssueState('tok', 'uuid-1', 'st-3')).rejects.toThrow(
      'Linear did not confirm issue status update.',
    );
  });
});

describe('isRetryableNetworkError', () => {
  it('treats TypeError network errors across browsers as retryable', () => {
    expect(isRetryableNetworkError(new TypeError('Load failed'))).toBe(true);
    expect(isRetryableNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryableNetworkError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(isRetryableNetworkError(new TypeError('fetch failed'))).toBe(true);
  });

  it('excludes AbortError even if wrapped or named AbortError', () => {
    expect(isRetryableNetworkError(new DOMException('The operation was aborted.', 'AbortError'))).toBe(false);
    expect(isRetryableNetworkError(Object.assign(new Error('Aborted'), { name: 'AbortError' }))).toBe(false);
    expect(isRetryableNetworkError(Object.assign(new TypeError('Load failed'), { name: 'AbortError' }))).toBe(false);
  });

  it('excludes non-network errors and non-objects', () => {
    expect(isRetryableNetworkError(new Error('Linear authentication expired. Please reconnect.'))).toBe(false);
    expect(isRetryableNetworkError(new SyntaxError('Unexpected token'))).toBe(false);
    expect(isRetryableNetworkError(null)).toBe(false);
    expect(isRetryableNetworkError(undefined)).toBe(false);
    expect(isRetryableNetworkError('Load failed')).toBe(false);
  });
});

describe('gql retry behavior', () => {
  beforeEach(() => {
    linearRequestMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries once on Safari TypeError("Load failed") and succeeds when retry recovers', async () => {
    linearRequestMock
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(jsonResponse({ viewer: { id: 'user-1', name: 'Alice' } }));

    const promise = testAuth('tok');
    const assertion = expect(promise).resolves.toEqual({ id: 'user-1', name: 'Alice' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(linearRequestMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on Safari TypeError("Load failed") for mutations and succeeds on retry', async () => {
    linearRequestMock
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(jsonResponse({ issueUpdate: { success: true } }));

    const promise = updateIssueState('tok', 'issue-1', 'state-2');
    const assertion = expect(promise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(linearRequestMock).toHaveBeenCalledTimes(2);
  });

  it('fails after one retry if Safari TypeError("Load failed") persists', async () => {
    linearRequestMock.mockRejectedValue(new TypeError('Load failed'));

    const promise = testAuth('tok');
    const assertion = expect(promise).rejects.toThrow('Load failed');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(linearRequestMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['Chrome', 'Failed to fetch'],
    ['Firefox', 'NetworkError when attempting to fetch resource.'],
  ])('retries once on %s TypeError("%s") and succeeds on retry', async (_browser, message) => {
    linearRequestMock
      .mockRejectedValueOnce(new TypeError(message))
      .mockResolvedValueOnce(jsonResponse({ viewer: { id: 'user-1', name: 'Alice' } }));

    const promise = testAuth('tok');
    const assertion = expect(promise).resolves.toEqual({ id: 'user-1', name: 'Alice' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(linearRequestMock).toHaveBeenCalledTimes(2);
  });

  it('retries once if reading the response body fails mid-stream with TypeError("Load failed")', async () => {
    const brokenBodyResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: () => Promise.reject(new TypeError('Load failed')),
    } as unknown as Response;

    linearRequestMock
      .mockResolvedValueOnce(brokenBodyResponse)
      .mockResolvedValueOnce(jsonResponse({ viewer: { id: 'user-1', name: 'Alice' } }));

    const promise = testAuth('tok');
    const assertion = expect(promise).resolves.toEqual({ id: 'user-1', name: 'Alice' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(linearRequestMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on DOMException AbortError or Error with name AbortError', async () => {
    const domAbort = new DOMException('The user aborted a request.', 'AbortError');
    linearRequestMock.mockRejectedValueOnce(domAbort);
    await expect(testAuth('tok')).rejects.toBe(domAbort);
    expect(linearRequestMock).toHaveBeenCalledTimes(1);

    linearRequestMock.mockReset();
    const errAbort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    linearRequestMock.mockRejectedValueOnce(errAbort);
    await expect(testAuth('tok')).rejects.toBe(errAbort);
    expect(linearRequestMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 401 auth expiry, HTTP 4xx, GraphQL errors, or invalid JSON SyntaxError', async () => {
    linearRequestMock.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await expect(testAuth('tok')).rejects.toThrow('Linear authentication expired. Please reconnect.');
    expect(linearRequestMock).toHaveBeenCalledTimes(1);

    linearRequestMock.mockReset();
    linearRequestMock.mockResolvedValueOnce(new Response('Bad Request', { status: 400, statusText: 'Bad Request' }));
    await expect(testAuth('tok')).rejects.toThrow('Linear API error (400): Bad Request');
    expect(linearRequestMock).toHaveBeenCalledTimes(1);

    linearRequestMock.mockReset();
    linearRequestMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ message: 'Entity not found' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(testAuth('tok')).rejects.toThrow('Entity not found');
    expect(linearRequestMock).toHaveBeenCalledTimes(1);

    linearRequestMock.mockReset();
    linearRequestMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 200 }));
    await expect(testAuth('tok')).rejects.toThrow();
    expect(linearRequestMock).toHaveBeenCalledTimes(1);
  });

  it('continues retrying 5xx responses up to 2 times as before', async () => {
    linearRequestMock
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ viewer: { id: 'user-1', name: 'Alice' } }));

    const promise = testAuth('tok');
    const assertion = expect(promise).resolves.toEqual({ id: 'user-1', name: 'Alice' });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    expect(linearRequestMock).toHaveBeenCalledTimes(3);

    linearRequestMock.mockReset();
    linearRequestMock.mockImplementation(async () => new Response('Server Error', { status: 500 }));
    const failingPromise = testAuth('tok');
    const failingAssertion = expect(failingPromise).rejects.toThrow('Linear API error (500): Server Error');
    await vi.advanceTimersByTimeAsync(5000);
    await failingAssertion;

    expect(linearRequestMock).toHaveBeenCalledTimes(3);
  });
});

describe('schedule date parsing', () => {
  it('parseStartDate reads YYYY-MM-DD and legacy DD-MM-YY and rejects invalid dates', () => {
    expect(parseStartDate('Intro\nstart: 2026-05-04\nmore')).toBe('2026-05-04');
    expect(parseStartDate('START:   2026-12-31')).toBe('2026-12-31');
    expect(parseStartDate('start: 04-05-26')).toBe('2026-05-04');
    expect(parseStartDate('start:04-05-26 trailing')).toBe('2026-05-04');
    expect(parseStartDate('start: 32-05-26')).toBeNull();
    expect(parseStartDate('start: 04-13-26')).toBeNull();
    expect(parseStartDate('start: 2026-13-01')).toBeNull();
    expect(parseStartDate('start: 04-05-2026')).toBeNull();
    expect(parseStartDate('no tag here')).toBeNull();
  });

  it('parseScheduleComment reads start/end from the bold heading or the plain heading, case-insensitively', () => {
    expect(parseScheduleComment('**GanttSmart Schedule**\nstart: 2026-05-04\nend: 2026-05-08')).toEqual({
      startDate: '2026-05-04',
      endDate: '2026-05-08',
    });
    expect(parseScheduleComment('GanttSmart schedule:\nStart: 2026-05-04\nEND: 2026-05-08')).toEqual({
      startDate: '2026-05-04',
      endDate: '2026-05-08',
    });
    expect(parseScheduleComment('**ganttsmart schedule**\n\nstart: 2026-05-04\n\nend: 2026-05-08\n')).toEqual({
      startDate: '2026-05-04',
      endDate: '2026-05-08',
    });
  });

  it('parseScheduleComment accepts partial schedules, due: as an alias for end:, and legacy DD-MM-YY', () => {
    expect(parseScheduleComment('**GanttSmart Schedule**\nstart: 2026-05-04')).toEqual({
      startDate: '2026-05-04',
      endDate: null,
    });
    expect(parseScheduleComment('**GanttSmart Schedule**\nend: 2026-05-08')).toEqual({
      startDate: null,
      endDate: '2026-05-08',
    });
    expect(parseScheduleComment('**GanttSmart Schedule**\ndue: 2026-05-08')).toEqual({
      startDate: null,
      endDate: '2026-05-08',
    });
    expect(parseScheduleComment('**GanttSmart Schedule**\nstart: 04-05-26\nend: 08-05-26')).toEqual({
      startDate: '2026-05-04',
      endDate: '2026-05-08',
    });
    expect(parseScheduleComment('**GanttSmart Schedule**\nend: 2026-05-08\ndue: 2026-06-01')?.endDate).toBe(
      '2026-05-08',
    );
  });

  it('parseScheduleComment ignores unrelated comments and schedule comments without a valid date', () => {
    expect(parseScheduleComment('start: 2026-05-04\nend: 2026-05-08')).toBeNull();
    expect(parseScheduleComment('Please see the GanttSmart Schedule\nstart: 2026-05-04')).toBeNull();
    expect(parseScheduleComment('**GanttSmart Schedule**\nstart: soon\nend: tomorrow')).toBeNull();
    expect(parseScheduleComment('**GanttSmart Schedule**')).toBeNull();
  });

  it('formatScheduleComment round-trips and omits unset dates', () => {
    const body = formatScheduleComment({ startDate: '2026-05-04', dueDate: '2026-05-08' });
    expect(body).toBe('**GanttSmart Schedule**\nstart: 2026-05-04\nend: 2026-05-08');
    expect(parseScheduleComment(body)).toEqual({ startDate: '2026-05-04', endDate: '2026-05-08' });
    expect(formatScheduleComment({ dueDate: '2026-05-08' })).toBe('**GanttSmart Schedule**\nend: 2026-05-08');
    expect(formatScheduleComment({ startDate: '2026-05-04', dueDate: null })).toBe(
      '**GanttSmart Schedule**\nstart: 2026-05-04',
    );
  });

  it('pickScheduleComment takes the latest valid schedule comment, skipping unrelated or invalid ones', () => {
    const picked = pickScheduleComment([
      { id: 'old', body: '**GanttSmart Schedule**\nstart: 2026-05-01', createdAt: '2026-05-01T00:00:00Z' },
      {
        id: 'edited',
        body: '**GanttSmart Schedule**\nstart: 2026-05-03\nend: 2026-05-09',
        createdAt: '2026-05-02T00:00:00Z',
        updatedAt: '2026-05-10T00:00:00Z',
      },
      { id: 'reply', body: '**GanttSmart Schedule**\nstart: 2026-05-02', createdAt: '2026-05-05T00:00:00Z' },
      { id: 'chatter', body: 'looks good', createdAt: '2026-05-20T00:00:00Z' },
      { id: 'invalid', body: '**GanttSmart Schedule**\nstart: nope', createdAt: '2026-05-21T00:00:00Z' },
      { id: 'null-body', body: null, createdAt: '2026-05-22T00:00:00Z' },
    ]);
    expect(picked).toMatchObject({ id: 'edited', startDate: '2026-05-03', endDate: '2026-05-09' });
    expect(pickScheduleComment([{ id: 'x', body: 'nothing' }])).toBeNull();
    expect(pickScheduleComment([])).toBeNull();
  });
});

describe('resolveIssueSchedule precedence', () => {
  const comment = {
    id: 'c1',
    startDate: '2026-05-04',
    endDate: '2026-05-08',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-02T00:00:00Z',
  };

  it('prefers the comment start over a legacy description tag and falls back to it', () => {
    expect(resolveIssueSchedule({ description: 'start: 01-05-26', comment })).toMatchObject({
      startDate: '2026-05-04',
    });
    expect(resolveIssueSchedule({ description: 'start: 01-05-26' })).toEqual({
      startDate: '2026-05-01',
      dueDate: null,
    });
    expect(
      resolveIssueSchedule({ description: 'start: 2026-05-02', comment: { ...comment, startDate: null } }),
    ).toEqual({ startDate: '2026-05-02', dueDate: '2026-05-08' });
  });

  it('uses the comment end, falling back to the native dueDate when the comment has no end', () => {
    expect(resolveIssueSchedule({ dueDate: '2026-05-08', comment }).dueDate).toBe('2026-05-08');
    expect(resolveIssueSchedule({ dueDate: null, comment }).dueDate).toBe('2026-05-08');
    expect(resolveIssueSchedule({ dueDate: '2026-05-20', comment: { ...comment, endDate: null } }).dueDate).toBe(
      '2026-05-20',
    );
    expect(resolveIssueSchedule({ dueDate: '2026-05-20' }).dueDate).toBe('2026-05-20');
  });

  it('lets a newer native dueDate edit (made in Linear) win over a stale comment end', () => {
    expect(
      resolveIssueSchedule({ dueDate: '2026-05-15', issueUpdatedAt: '2026-05-03T00:00:00Z', comment }).dueDate,
    ).toBe('2026-05-15');
  });

  it('treats the due date as cleared when dueDate is removed in Linear after the schedule comment was written', () => {
    expect(resolveIssueSchedule({ dueDate: null, issueUpdatedAt: '2026-05-03T00:00:00Z', comment }).dueDate).toBeNull();
    // Comment newer than the issue, or no timestamps: the comment end still applies
    expect(resolveIssueSchedule({ dueDate: null, issueUpdatedAt: '2026-05-01T00:00:00Z', comment }).dueDate).toBe(
      '2026-05-08',
    );
    expect(resolveIssueSchedule({ dueDate: null, comment }).dueDate).toBe('2026-05-08');
  });

  it('keeps the comment end when it is newer than the issue or timestamps are unavailable', () => {
    expect(
      resolveIssueSchedule({ dueDate: '2026-05-15', issueUpdatedAt: '2026-05-01T00:00:00Z', comment }).dueDate,
    ).toBe('2026-05-08');
    expect(resolveIssueSchedule({ dueDate: '2026-05-15', comment }).dueDate).toBe('2026-05-08');
  });
});

describe('fetchIssues schedule comments', () => {
  beforeEach(() => {
    linearRequestMock.mockReset();
  });

  function projectResponse(nodes: Array<Record<string, unknown>>) {
    return jsonResponse({
      project: {
        name: 'Sched',
        startDate: null,
        targetDate: '2026-06-30',
        projectMilestones: { nodes: [] },
        issues: { nodes },
        doneIssues: { nodes: [] },
      },
    });
  }

  it('prefers schedule comment dates, falling back to legacy description tags and native dueDate', async () => {
    linearRequestMock.mockImplementation(async (_t: string, body: { query: string }) => {
      if (body.query.includes('project(id:')) {
        return projectResponse([
          makeIssueNode({ id: 'u1', identifier: 'S-1', description: 'start: 01-05-26', dueDate: '2026-05-10' }),
          makeIssueNode({
            id: 'u2',
            identifier: 'S-2',
            description: 'start: 2026-05-03\nnotes',
            dueDate: '2026-05-12',
          }),
          makeIssueNode({ id: 'u3', identifier: 'S-3', description: '', dueDate: null }),
          makeIssueNode({ id: 'u4', identifier: 'S-4', description: 'start: 01-05-26', dueDate: '2026-05-30' }),
        ]);
      }
      if (body.query.includes('ScheduleComments')) {
        return jsonResponse({
          issues: {
            nodes: [
              {
                id: 'u1',
                updatedAt: '2026-05-02T00:00:00Z',
                comments: {
                  nodes: [
                    {
                      id: 'c1',
                      body: '**GanttSmart Schedule**\nstart: 2026-05-04\nend: 2026-05-08',
                      createdAt: '2026-05-01T00:00:00Z',
                      updatedAt: '2026-05-02T00:00:00Z',
                    },
                  ],
                },
              },
              { id: 'u2', updatedAt: '2026-05-02T00:00:00Z', comments: { nodes: [] } },
              {
                id: 'u3',
                updatedAt: '2026-05-02T00:00:00Z',
                comments: {
                  nodes: [{ id: 'c3', body: '**GanttSmart Schedule**\nstart: 2026-05-05\nend: 2026-05-07' }],
                },
              },
              {
                // Native dueDate edited in Linear after the comment was last written
                id: 'u4',
                updatedAt: '2026-05-20T00:00:00Z',
                comments: {
                  nodes: [
                    {
                      id: 'c4',
                      body: '**GanttSmart Schedule**\nstart: 2026-05-04\nend: 2026-05-08',
                      createdAt: '2026-05-01T00:00:00Z',
                      updatedAt: '2026-05-02T00:00:00Z',
                    },
                  ],
                },
              },
            ],
          },
        });
      }
      return jsonResponse({ issues: { nodes: [] } });
    });

    const result = await fetchIssues('tok', 'proj-1');
    const byId = Object.fromEntries([...result.tasks, ...result.unscheduledTasks].map((t) => [t.id, t]));

    expect(byId['S-1']).toMatchObject({ startDate: '2026-05-04', due: '2026-05-08' });
    expect(byId['S-1'].isDueImplicit).toBeUndefined();
    expect(byId['S-2']).toMatchObject({ startDate: '2026-05-03', due: '2026-05-12' });
    // Schedule comment gives an otherwise unscheduled issue an explicit due date
    expect(result.unscheduledTasks).toEqual([]);
    expect(byId['S-3']).toMatchObject({ startDate: '2026-05-05', due: '2026-05-07' });
    expect(byId['S-3'].isDueImplicit).toBeUndefined();
    expect(byId['S-4']).toMatchObject({ startDate: '2026-05-04', due: '2026-05-30' });
  });

  it('applies schedule comments to cross-project external issues', async () => {
    linearRequestMock.mockImplementation(
      async (_t: string, body: { query: string; variables?: { ids?: string[] } }) => {
        if (body.query.includes('project(id:')) {
          return projectResponse([makeIssueNode({ id: 'u1', identifier: 'S-1' })]);
        }
        if (body.query.includes('ScheduleComments')) {
          return jsonResponse({
            issues: {
              nodes: [
                {
                  id: 'ext-1',
                  updatedAt: '2026-05-02T00:00:00Z',
                  comments: {
                    nodes: [{ id: 'c1', body: '**GanttSmart Schedule**\nstart: 2026-05-04\nend: 2026-05-09' }],
                  },
                },
              ],
            },
          });
        }
        return jsonResponse({
          issues: {
            nodes: [
              {
                id: 'u1',
                identifier: 'S-1',
                relations: {
                  nodes: [
                    {
                      type: 'blocked_by',
                      relatedIssue: {
                        id: 'ext-1',
                        identifier: 'X-1',
                        title: 'External',
                        description: 'start: 01-05-26',
                        dueDate: null,
                        state: { name: 'Todo', type: 'unstarted' },
                        project: { id: 'proj-x', name: 'Other', targetDate: null },
                      },
                    },
                  ],
                },
                children: { nodes: [] },
              },
            ],
          },
        });
      },
    );

    const result = await fetchIssues('tok', 'proj-1');
    expect(result.externalUnscheduledTasks).toEqual([]);
    expect(result.externalTasks[0]).toMatchObject({
      id: 'X-1',
      startDate: '2026-05-04',
      due: '2026-05-09',
    });
    const commentCall = linearRequestMock.mock.calls.find((c) => c[1].query.includes('ScheduleComments'));
    expect(commentCall?.[1].variables.ids).toEqual(['u1', 'ext-1']);
  });

  it('fetches comments in batches that keep every request far below the 10,000 complexity limit', async () => {
    const nodes = Array.from({ length: 260 }, (_, i) =>
      makeIssueNode({ id: `u${i}`, identifier: `S-${i}`, title: `Task ${i}` }),
    );
    const commentBatches: string[][] = [];
    linearRequestMock.mockImplementation(
      async (_t: string, body: { query: string; variables?: { ids?: string[] } }) => {
        if (body.query.includes('project(id:')) return projectResponse(nodes);
        if (body.query.includes('ScheduleComments')) {
          commentBatches.push(body.variables!.ids!);
          return jsonResponse({
            issues: {
              nodes: body.variables!.ids!.map((id) => ({ id, updatedAt: null, comments: { nodes: [] } })),
            },
          });
        }
        return jsonResponse({ issues: { nodes: [] } });
      },
    );

    const result = await fetchIssues('tok', 'proj-1');
    expect(result.tasks).toHaveLength(260);
    expect(commentBatches).toHaveLength(Math.ceil(260 / SCHEDULE_COMMENT_BATCH_SIZE));
    for (const batch of commentBatches) expect(batch.length).toBeLessThanOrEqual(SCHEDULE_COMMENT_BATCH_SIZE);
    expect(commentBatches.flat().sort()).toEqual(nodes.map((n) => n.id as string).sort());

    // Each request: batch size issues * comments per issue, well under the limit
    const perRequest = estimateLinearQueryComplexity(SCHEDULE_COMMENTS_QUERY);
    expect(perRequest).toBeLessThan(1500);
    expect(SCHEDULE_COMMENT_BATCH_SIZE * SCHEDULE_COMMENTS_PER_ISSUE).toBeLessThan(1000);
    expect(estimateLinearQueryComplexity(ISSUE_SCHEDULE_QUERY)).toBeLessThan(500);

    // Regression guard: nesting comments in the 250-issue project query would have blown the limit
    const naive = `query { project(id: "p") { issues(first: 250) { nodes { id comments(first: 50) { nodes { id body createdAt updatedAt } } } } } }`;
    expect(estimateLinearQueryComplexity(naive)).toBeGreaterThan(10_000);
    const issuesQueryText = linearRequestMock.mock.calls.find((c) => c[1].query.includes('project(id:'))![1].query;
    expect(issuesQueryText).not.toContain('comments');
  });

  it('requests the newest-updated schedule comments with a server-side body filter', () => {
    for (const query of [SCHEDULE_COMMENTS_QUERY, ISSUE_SCHEDULE_QUERY]) {
      expect(query).toContain(
        `comments(first: ${SCHEDULE_COMMENTS_PER_ISSUE}, orderBy: updatedAt, filter: { body: { containsIgnoreCase: "GanttSmart schedule" } })`,
      );
    }
  });

  it('keeps legacy and native dates when the schedule comments request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    linearRequestMock.mockImplementation(async (_t: string, body: { query: string }) => {
      if (body.query.includes('project(id:')) {
        return projectResponse([makeIssueNode({ id: 'u1', identifier: 'S-1', description: 'start: 01-05-26' })]);
      }
      if (body.query.includes('ScheduleComments')) throw new Error('boom');
      return jsonResponse({ issues: { nodes: [] } });
    });
    const result = await fetchIssues('tok', 'proj-1');
    expect(result.tasks[0]).toMatchObject({ startDate: '2026-05-01', due: '2026-11-20' });
    warn.mockRestore();
  });
});

describe('schedule mutations', () => {
  interface MockComment {
    id: string;
    body: string;
    createdAt: string;
    updatedAt: string;
  }

  interface MockIssue {
    description: string | null;
    dueDate: string | null;
    updatedAt: string;
    comments: MockComment[];
  }

  let issue: MockIssue;
  let calls: Array<{ kind: string; variables: Record<string, unknown> }>;

  function installBackend() {
    linearRequestMock.mockImplementation(
      async (_t: string, body: { query: string; variables?: Record<string, string | undefined> }) => {
        const variables = body.variables ?? {};
        if (body.query.includes('IssueSchedule')) {
          calls.push({ kind: 'read', variables });
          return jsonResponse({ issue: { ...issue, comments: { nodes: issue.comments } } });
        }
        if (body.query.includes('commentCreate')) {
          calls.push({ kind: 'commentCreate', variables });
          issue.comments.push({
            id: `comment-${issue.comments.length + 1}`,
            body: variables.body ?? '',
            createdAt: '2026-11-21T10:00:00Z',
            updatedAt: '2026-11-21T10:00:00Z',
          });
          return jsonResponse({ commentCreate: { success: true } });
        }
        if (body.query.includes('commentUpdate')) {
          calls.push({ kind: 'commentUpdate', variables });
          const target = issue.comments.find((c) => c.id === variables.commentId)!;
          target.body = variables.body ?? '';
          target.updatedAt = '2026-11-21T11:00:00Z';
          return jsonResponse({ commentUpdate: { success: true } });
        }
        if (body.query.includes('issueUpdate')) {
          calls.push({ kind: 'issueUpdate', variables });
          if (variables.dueDate) issue.dueDate = variables.dueDate as string;
          return jsonResponse({ issueUpdate: { success: true } });
        }
        throw new Error(`Unexpected query: ${body.query}`);
      },
    );
  }

  beforeEach(() => {
    linearRequestMock.mockReset();
    calls = [];
    issue = { description: null, dueDate: null, updatedAt: '2026-11-01T00:00:00Z', comments: [] };
    installBackend();
  });

  it('creates a schedule comment with both dates, preserving the native dueDate when only start changes', async () => {
    issue.dueDate = '2026-12-10';
    issue.description = 'Plan\nstart: 01-12-26';

    await updateIssueStartDate('tok', 'uuid-1', '2026-12-03');

    expect(calls.map((c) => c.kind)).toEqual(['read', 'commentCreate']);
    expect(calls[1].variables).toEqual({
      issueId: 'uuid-1',
      body: '**GanttSmart Schedule**\nstart: 2026-12-03\nend: 2026-12-10',
    });
    // Description (with its legacy tag) is left untouched and no description mutation is sent
    expect(issue.description).toBe('Plan\nstart: 01-12-26');
    expect(calls.some((c) => 'description' in c.variables)).toBe(false);
  });

  it('creates a start-only comment when no dates exist, and preserves a legacy description start on due updates', async () => {
    await updateIssueStartDate('tok', 'uuid-1', '2026-12-03');
    expect(issue.comments[0].body).toBe('**GanttSmart Schedule**\nstart: 2026-12-03');

    calls = [];
    issue = { description: 'start: 01-12-26', dueDate: null, updatedAt: '2026-11-01T00:00:00Z', comments: [] };
    await updateIssueDueDate('tok', 'uuid-2', '2026-12-09');
    expect(calls.map((c) => c.kind)).toEqual(['read', 'issueUpdate', 'commentCreate']);
    expect(issue.comments[0].body).toBe('**GanttSmart Schedule**\nstart: 2026-12-01\nend: 2026-12-09');
  });

  it('updates the existing schedule comment in place instead of creating another', async () => {
    issue.dueDate = '2026-12-10';
    issue.comments = [
      { id: 'chat', body: 'unrelated', createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z' },
      {
        id: 'sched',
        body: '**GanttSmart Schedule**\nstart: 2026-12-01\nend: 2026-12-10',
        createdAt: '2026-11-03T00:00:00Z',
        updatedAt: '2026-11-03T00:00:00Z',
      },
    ];
    issue.updatedAt = '2026-11-03T00:00:00Z';

    await updateIssueStartDate('tok', 'uuid-1', '2026-12-02');

    expect(calls.map((c) => c.kind)).toEqual(['read', 'commentUpdate']);
    expect(calls[1].variables).toEqual({
      commentId: 'sched',
      body: '**GanttSmart Schedule**\nstart: 2026-12-02\nend: 2026-12-10',
    });
    expect(issue.comments).toHaveLength(2);
  });

  it('updateIssueDueDate updates the comment end and syncs the native dueDate', async () => {
    issue.dueDate = '2026-12-10';
    issue.comments = [
      {
        id: 'sched',
        body: '**GanttSmart Schedule**\nstart: 2026-12-01\nend: 2026-12-10',
        createdAt: '2026-11-03T00:00:00Z',
        updatedAt: '2026-11-03T00:00:00Z',
      },
    ];

    await updateIssueDueDate('tok', 'uuid-1', '2026-12-15');

    expect(calls.map((c) => c.kind)).toEqual(['read', 'issueUpdate', 'commentUpdate']);
    expect(calls[1].variables).toEqual({ id: 'uuid-1', dueDate: '2026-12-15' });
    expect(calls[2].variables.body).toBe('**GanttSmart Schedule**\nstart: 2026-12-01\nend: 2026-12-15');
    expect(issue.dueDate).toBe('2026-12-15');
  });

  it('uses a newer native dueDate (edited in Linear) when preserving the end on a start update', async () => {
    issue.dueDate = '2026-12-20';
    issue.updatedAt = '2026-11-10T00:00:00Z';
    issue.comments = [
      {
        id: 'sched',
        body: '**GanttSmart Schedule**\nstart: 2026-12-01\nend: 2026-12-10',
        createdAt: '2026-11-03T00:00:00Z',
        updatedAt: '2026-11-03T00:00:00Z',
      },
    ];

    await updateIssueStartDate('tok', 'uuid-1', '2026-12-02');
    expect(issue.comments[0].body).toBe('**GanttSmart Schedule**\nstart: 2026-12-02\nend: 2026-12-20');
  });

  it('serializes concurrent start and due updates so moving a bar yields one comment containing both dates', async () => {
    issue.dueDate = '2026-12-10';
    issue.description = 'start: 01-12-26';

    await Promise.all([
      updateIssueStartDate('tok', 'uuid-1', '2026-12-03'),
      updateIssueDueDate('tok', 'uuid-1', '2026-12-12'),
    ]);

    expect(calls.filter((c) => c.kind === 'commentCreate')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'commentUpdate')).toHaveLength(1);
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0].body).toBe('**GanttSmart Schedule**\nstart: 2026-12-03\nend: 2026-12-12');
    expect(issue.dueDate).toBe('2026-12-12');
    // No interleaving: each write completes (read -> comment write [-> issueUpdate]) before the next begins
    const kinds = calls.map((c) => c.kind);
    expect(kinds.indexOf('read', 1)).toBeGreaterThan(kinds.indexOf('commentCreate'));
  });

  it('keeps writing after a failed update for the same issue', async () => {
    linearRequestMock.mockImplementationOnce(async () => {
      throw new Error('Linear down');
    });
    await expect(updateIssueStartDate('tok', 'uuid-1', '2026-12-03')).rejects.toThrow('Linear down');
    await updateIssueStartDate('tok', 'uuid-1', '2026-12-04');
    expect(issue.comments[0].body).toBe('**GanttSmart Schedule**\nstart: 2026-12-04');
  });

  it('throws when Linear does not confirm the comment write', async () => {
    linearRequestMock.mockImplementation(async (_t: string, body: { query: string }) => {
      if (body.query.includes('IssueSchedule')) return jsonResponse({ issue: { comments: { nodes: [] } } });
      return jsonResponse({ commentCreate: { success: false } });
    });
    await expect(updateIssueStartDate('tok', 'uuid-1', '2026-12-03')).rejects.toThrow(/schedule comment/);
  });
});
