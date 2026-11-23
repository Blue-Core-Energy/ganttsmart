import { describe, expect, it } from 'vitest';
import type { Task, WorkflowState } from '@/types';
import { isTaskDone } from './tasks';
import { applyWorkflowStateToTask, findWorkflowStateForTask, sortWorkflowStatesForMenu } from './workflowStates';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'IT-86',
    uuid: 'uuid-86',
    title: 'Update status dropdown',
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

describe('sortWorkflowStatesForMenu', () => {
  it('keeps every state, ordered by workflow progression with canceled and duplicate last', () => {
    const states: WorkflowState[] = [
      { id: 'dup', name: 'Duplicate', type: 'duplicate', position: 0 },
      { id: 'done', name: 'Done', type: 'completed', position: 3 },
      { id: 'cancel', name: 'Canceled', type: 'canceled', position: 4 },
      { id: 'prog', name: 'In Progress', type: 'started', position: 2 },
      { id: 'todo', name: 'Todo', type: 'unstarted', position: 1 },
      { id: 'back', name: 'Backlog', type: 'backlog', position: 0 },
    ];
    expect(sortWorkflowStatesForMenu(states).map((s) => s.id)).toEqual([
      'back',
      'todo',
      'prog',
      'done',
      'cancel',
      'dup',
    ]);
    expect(states[0].id).toBe('dup');
  });
});
