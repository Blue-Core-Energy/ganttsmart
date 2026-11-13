import { describe, expect, it } from 'vitest';
import type { Task, WorkflowState } from '@/types';
import { isTaskDone } from './tasks';
import {
  applyWorkflowStateToTask,
  findWorkflowStateForTask,
  getNextWorkflowState,
  sortCyclableWorkflowStates,
} from './workflowStates';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'IT-86',
    uuid: 'uuid-86',
    title: 'Cycle status bubble',
    description: '',
    due: '2026-11-20',
    startDate: '2026-11-10',
    priorityVal: 2,
    priority: 'High',
    status: 'In Progress',
    statusType: 'started',
    assignee: 'Andrew Phillips',
    url: 'https://linear.app/bluecoreenergy/issue/IT-86',
    teamId: 'team-1',
    blocks: [],
    blockedBy: [],
    progress: 0,
    totalChildren: 0,
    completedChildren: 0,
    ...overrides,
  };
}

const fullTeamStates: WorkflowState[] = [
  // Deliberately unsorted with position: 0 across types (as Linear often returns)
  { id: 'st-dup', name: 'Duplicate', type: 'duplicate', position: 0 },
  { id: 'st-done', name: 'Done', type: 'completed', position: 0 },
  { id: 'st-can', name: 'Canceled', type: 'canceled', position: 0 },
  { id: 'st-prog', name: 'In Progress', type: 'started', position: 0 },
  { id: 'st-rev', name: 'In Review', type: 'started', position: 1 },
  { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 'st-back', name: 'Backlog', type: 'backlog', position: 0 },
];

describe('sortCyclableWorkflowStates', () => {
  it('excludes canceled and duplicate states and sorts by workflow stage then position', () => {
    const sorted = sortCyclableWorkflowStates(fullTeamStates);
    expect(sorted.map((s) => `${s.name}:${s.type}`)).toEqual([
      'Backlog:backlog',
      'Todo:unstarted',
      'In Progress:started',
      'In Review:started',
      'Done:completed',
    ]);
  });

  it('excludes states named Duplicate or Cancelled even if type is unstarted/backlog', () => {
    const states: WorkflowState[] = [
      { id: '1', name: 'Todo', type: 'unstarted', position: 0 },
      { id: '2', name: 'Duplicate', type: 'backlog', position: 1 },
      { id: '3', name: 'Cancelled', type: 'unstarted', position: 2 },
      { id: '4', name: 'Done', type: 'completed', position: 3 },
    ];
    expect(sortCyclableWorkflowStates(states).map((s) => s.name)).toEqual(['Todo', 'Done']);
  });
});

describe('getNextWorkflowState', () => {
  it('cycles backlog -> unstarted -> started -> completed -> backlog while skipping canceled/duplicate', () => {
    const states: WorkflowState[] = [
      { id: 'st-back', name: 'Backlog', type: 'backlog', position: 0 },
      { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 },
      { id: 'st-prog', name: 'In Progress', type: 'started', position: 0 },
      { id: 'st-done', name: 'Done', type: 'completed', position: 0 },
      { id: 'st-can', name: 'Canceled', type: 'canceled', position: 0 },
      { id: 'st-dup', name: 'Duplicate', type: 'duplicate', position: 0 },
    ];

    const s1 = getNextWorkflowState({ status: 'Backlog', statusType: 'backlog' }, states);
    expect(s1?.name).toBe('Todo');

    const s2 = getNextWorkflowState({ status: 'Todo', statusType: 'unstarted' }, states);
    expect(s2?.name).toBe('In Progress');

    const s3 = getNextWorkflowState({ status: 'In Progress', statusType: 'started' }, states);
    expect(s3?.name).toBe('Done');

    const s4 = getNextWorkflowState({ status: 'Done', statusType: 'completed' }, states);
    expect(s4?.name).toBe('Backlog');
  });

  it('cycles through multiple states of the same type in position order', () => {
    const s1 = getNextWorkflowState({ status: 'In Progress', statusType: 'started' }, fullTeamStates);
    expect(s1?.name).toBe('In Review');

    const s2 = getNextWorkflowState({ status: 'In Review', statusType: 'started' }, fullTeamStates);
    expect(s2?.name).toBe('Done');
  });

  it('wraps completed -> unstarted when the team has no backlog state', () => {
    const noBacklog: WorkflowState[] = [
      { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 },
      { id: 'st-prog', name: 'In Progress', type: 'started', position: 1 },
      { id: 'st-done', name: 'Done', type: 'completed', position: 2 },
    ];
    expect(getNextWorkflowState({ status: 'Done', statusType: 'completed' }, noBacklog)?.name).toBe('Todo');
  });

  it('advances triage tasks into backlog/unstarted without wrapping completed tasks back into triage', () => {
    const withTriage: WorkflowState[] = [
      { id: 'st-tri', name: 'Triage', type: 'triage', position: 0 },
      { id: 'st-back', name: 'Backlog', type: 'backlog', position: 0 },
      { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 },
      { id: 'st-prog', name: 'In Progress', type: 'started', position: 0 },
      { id: 'st-done', name: 'Done', type: 'completed', position: 0 },
    ];
    expect(getNextWorkflowState({ status: 'Triage', statusType: 'triage' }, withTriage)?.name).toBe('Backlog');
    expect(getNextWorkflowState({ status: 'Done', statusType: 'completed' }, withTriage)?.name).toBe('Backlog');
  });

  it('falls back gracefully when current status is unrecognized or canceled', () => {
    expect(getNextWorkflowState({ status: 'Legacy Started', statusType: 'started' }, fullTeamStates)?.name).toBe(
      'Done',
    );
    expect(getNextWorkflowState({ status: 'Canceled', statusType: 'canceled' }, fullTeamStates)?.name).toBe('Backlog');
  });

  it('matches state names case-insensitively and returns null when there is no distinct next state', () => {
    expect(getNextWorkflowState({ status: ' in progress ', statusType: 'STARTED' }, fullTeamStates)?.name).toBe(
      'In Review',
    );
    expect(getNextWorkflowState({ status: 'Todo', statusType: 'unstarted' }, [])).toBeNull();
    expect(
      getNextWorkflowState({ status: 'In Progress', statusType: 'started' }, [
        { id: '1', name: 'In Progress', type: 'started', position: 0 },
        { id: '2', name: 'Canceled', type: 'canceled', position: 1 },
      ]),
    ).toBeNull();
  });
});

describe('applyWorkflowStateToTask & isTaskDone', () => {
  it('sets completedAt optimistically when transitioning into completed so isTaskDone is true', () => {
    const active = makeTask({ status: 'In Progress', statusType: 'started', completedAt: undefined });
    expect(isTaskDone(active)).toBe(false);

    const updated = applyWorkflowStateToTask(active, { name: 'Done', type: 'completed' }, '2026-11-12T10:00:00.000Z');
    expect(updated.status).toBe('Done');
    expect(updated.statusType).toBe('completed');
    expect(updated.completedAt).toBe('2026-11-12T10:00:00.000Z');
    expect(isTaskDone(updated)).toBe(true);
  });

  it('clears completedAt optimistically when transitioning out of completed so isTaskDone becomes false immediately', () => {
    const completed = makeTask({
      status: 'Done',
      statusType: 'completed',
      completedAt: '2026-11-01T12:00:00.000Z',
    });
    expect(isTaskDone(completed)).toBe(true);

    const reopened = applyWorkflowStateToTask(completed, { name: 'Backlog', type: 'backlog' });
    expect(reopened.status).toBe('Backlog');
    expect(reopened.statusType).toBe('backlog');
    expect(reopened.completedAt).toBeUndefined();
    expect(isTaskDone(reopened)).toBe(false);
  });
});

describe('findWorkflowStateForTask', () => {
  it('finds the matching state by name and type', () => {
    const found = findWorkflowStateForTask({ status: 'In Progress', statusType: 'started' }, fullTeamStates);
    expect(found?.id).toBe('st-prog');
  });
});
