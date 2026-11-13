import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { filterActiveTasks, isIgnoredIssueState, isIgnoredTask } from './issues';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'ENG-1',
    uuid: 'uuid-1',
    title: 'Sample task',
    description: '',
    due: '2026-11-20',
    startDate: null,
    priorityVal: 2,
    priority: 'High',
    status: 'In Progress',
    statusType: 'started',
    assignee: 'Alice',
    url: 'https://linear.app/test/issue/ENG-1',
    teamId: 'team-1',
    blocks: [],
    blockedBy: [],
    progress: 0,
    totalChildren: 0,
    completedChildren: 0,
    ...overrides,
  };
}

describe('isIgnoredIssueState', () => {
  it('ignores issues with canceledAt timestamp set', () => {
    expect(isIgnoredIssueState({ name: 'Todo', type: 'unstarted' }, '2026-11-01T00:00:00Z')).toBe(true);
    expect(isIgnoredIssueState(null, '2026-11-01T00:00:00Z')).toBe(true);
  });

  it('ignores Linear canceled and duplicate workflow state types', () => {
    expect(isIgnoredIssueState({ name: 'Canceled', type: 'canceled' })).toBe(true);
    expect(isIgnoredIssueState({ name: 'Rejected', type: 'canceled' })).toBe(true);
    expect(isIgnoredIssueState({ name: 'Obsolete', type: 'canceled' })).toBe(true);
    expect(isIgnoredIssueState({ name: 'Duplicate', type: 'duplicate' })).toBe(true);
    expect(isIgnoredIssueState({ name: 'Dup', type: 'DUPLICATE' })).toBe(true);
    expect(isIgnoredIssueState({ name: 'Cancelled', type: 'cancelled' })).toBe(true);
  });

  it('ignores custom states named Duplicate or Canceled/Cancelled regardless of type', () => {
    expect(isIgnoredIssueState({ name: 'Duplicate', type: 'backlog' })).toBe(true);
    expect(isIgnoredIssueState({ name: ' duplicate ', type: 'unstarted' })).toBe(true);
    expect(isIgnoredIssueState({ name: 'Canceled', type: 'unstarted' })).toBe(true);
    expect(isIgnoredIssueState({ name: 'Cancelled', type: 'backlog' })).toBe(true);
  });

  it('keeps active and completed workflow states', () => {
    expect(isIgnoredIssueState({ name: 'Triage', type: 'triage' }, null)).toBe(false);
    expect(isIgnoredIssueState({ name: 'Backlog', type: 'backlog' }, null)).toBe(false);
    expect(isIgnoredIssueState({ name: 'Todo', type: 'unstarted' }, null)).toBe(false);
    expect(isIgnoredIssueState({ name: 'In Progress', type: 'started' }, null)).toBe(false);
    expect(isIgnoredIssueState({ name: 'Done', type: 'completed' }, null)).toBe(false);
    expect(isIgnoredIssueState({ name: 'Deduplicate pipeline', type: 'started' }, null)).toBe(false);
    expect(isIgnoredIssueState(null, null)).toBe(false);
    expect(isIgnoredIssueState(undefined, undefined)).toBe(false);
  });
});

describe('isIgnoredTask', () => {
  it('detects duplicate and canceled tasks from status and statusType', () => {
    expect(isIgnoredTask(makeTask({ status: 'Duplicate', statusType: 'duplicate' }))).toBe(true);
    expect(isIgnoredTask(makeTask({ status: 'Duplicate', statusType: 'canceled' }))).toBe(true);
    expect(isIgnoredTask(makeTask({ status: 'Duplicate', statusType: 'backlog' }))).toBe(true);
    expect(isIgnoredTask(makeTask({ status: 'Rejected', statusType: 'canceled' }))).toBe(true);
    expect(isIgnoredTask(makeTask({ status: 'In Progress', statusType: 'started' }))).toBe(false);
  });
});

describe('filterActiveTasks', () => {
  it('filters out duplicate/canceled tasks and strips broken dependency references', () => {
    const tasks = [
      makeTask({ id: 'ENG-1', blocks: ['ENG-2', 'ENG-3'], blockedBy: ['ENG-4'] }),
      makeTask({ id: 'ENG-2', status: 'Todo', statusType: 'unstarted', blockedBy: ['ENG-1'] }),
      makeTask({ id: 'ENG-3', status: 'Duplicate', statusType: 'duplicate', blockedBy: ['ENG-1'] }),
      makeTask({ id: 'ENG-4', status: 'Canceled', statusType: 'canceled', blocks: ['ENG-1'] }),
    ];

    const result = filterActiveTasks(tasks, new Set(['ENG-5']));
    expect(result.map((t) => t.id)).toEqual(['ENG-1', 'ENG-2']);
    expect(result[0].blocks).toEqual(['ENG-2']);
    expect(result[0].blockedBy).toEqual([]);
    expect(result[1].blockedBy).toEqual(['ENG-1']);
  });
});
