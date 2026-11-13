import { describe, expect, it } from 'vitest';
import type { Filters, Task } from '@/types';
import {
  applyCustomOrder,
  computeDepViolations,
  computeTaskStats,
  filterTasks,
  groupTasks,
  isTaskDone,
  mergeUnifiedTasks,
  sortTasks,
} from './tasks';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'ENG-1',
    uuid: 'uuid-1',
    title: 'Sample task',
    description: '',
    due: '2026-05-10',
    startDate: '2026-05-05',
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

function defaultFilters(overrides: Partial<Filters> = {}): Filters {
  return {
    assignee: '',
    status: '',
    priorities: new Set([0, 1, 2, 3, 4]),
    search: '',
    dateFrom: '',
    dateTo: '',
    showCompleted: true,
    ...overrides,
  };
}

describe('isTaskDone', () => {
  it('returns true for completed statusType', () => {
    expect(isTaskDone(makeTask({ statusType: 'completed' }))).toBe(true);
  });

  it('returns true when completedAt is present on non-canceled tasks', () => {
    expect(isTaskDone(makeTask({ statusType: 'started', completedAt: '2026-05-01T12:00:00Z' }))).toBe(true);
  });

  it('returns false for canceled tasks even if completedAt is set', () => {
    expect(isTaskDone(makeTask({ statusType: 'canceled', completedAt: '2026-05-01T12:00:00Z' }))).toBe(false);
  });

  it('returns false for active tasks', () => {
    expect(isTaskDone(makeTask({ statusType: 'unstarted', completedAt: undefined }))).toBe(false);
    expect(isTaskDone(makeTask({ statusType: 'started', completedAt: undefined }))).toBe(false);
  });
});

describe('sortTasks', () => {
  it('sorts active and completed tasks together by priority then due date', () => {
    const activeHigh = makeTask({ id: 'ENG-2', uuid: 'u2', priorityVal: 2, due: '2026-05-15' });
    const doneUrgent = makeTask({
      id: 'ENG-1',
      uuid: 'u1',
      priorityVal: 1,
      due: '2026-05-05',
      status: 'Done',
      statusType: 'completed',
      completedAt: '2026-05-04T00:00:00Z',
    });
    const doneHighEarlier = makeTask({
      id: 'ENG-3',
      uuid: 'u3',
      priorityVal: 2,
      due: '2026-05-08',
      status: 'Done',
      statusType: 'completed',
      completedAt: '2026-05-07T00:00:00Z',
    });

    const sorted = sortTasks([activeHigh, doneHighEarlier, doneUrgent]);
    expect(sorted.map((t) => t.id)).toEqual(['ENG-1', 'ENG-3', 'ENG-2']);
  });
});

describe('applyCustomOrder', () => {
  it('orders mixed active and completed tasks by customOrder and appends unseen tasks', () => {
    const t1 = makeTask({ id: 'ENG-1', uuid: 'u1' });
    const t2 = makeTask({ id: 'ENG-2', uuid: 'u2', statusType: 'completed' });
    const t3 = makeTask({ id: 'ENG-3', uuid: 'u3' });

    const ordered = applyCustomOrder([t1, t2, t3], ['u2', 'u1']);
    expect(ordered.map((t) => t.id)).toEqual(['ENG-2', 'ENG-1', 'ENG-3']);
  });
});

describe('mergeUnifiedTasks', () => {
  it('merges legacy doneTasks into tasks without duplicates', () => {
    const active = makeTask({ id: 'ENG-2', uuid: 'u2', priorityVal: 2, due: '2026-05-12' });
    const doneDup = makeTask({ id: 'ENG-2', uuid: 'u2', statusType: 'completed' });
    const legacyDone = makeTask({
      id: 'ENG-1',
      uuid: 'u1',
      priorityVal: 1,
      due: '2026-05-03',
      status: 'Done',
      statusType: 'completed',
    });

    const merged = mergeUnifiedTasks([active], [doneDup, legacyDone]);
    expect(merged.map((t) => t.id)).toEqual(['ENG-1', 'ENG-2']);
  });

  it('returns original array when doneTasks is empty', () => {
    const active = makeTask();
    const list = [active];
    expect(mergeUnifiedTasks(list, [])).toBe(list);
  });
});

describe('filterTasks', () => {
  const active = makeTask({ id: 'ENG-1', uuid: 'u1', assignee: 'Alice', status: 'In Progress', priorityVal: 2 });
  const done = makeTask({
    id: 'ENG-2',
    uuid: 'u2',
    title: 'Completed setup',
    assignee: 'Bob',
    status: 'Done',
    statusType: 'completed',
    completedAt: '2026-05-02T00:00:00Z',
    priorityVal: 3,
  });

  it('shows completed tasks inline by default', () => {
    expect(filterTasks([active, done], defaultFilters()).map((t) => t.id)).toEqual(['ENG-1', 'ENG-2']);
  });

  it('hides completed tasks when showCompleted is false', () => {
    expect(filterTasks([active, done], defaultFilters({ showCompleted: false })).map((t) => t.id)).toEqual(['ENG-1']);
  });

  it('filters completed tasks by status, assignee, priority, and search', () => {
    expect(filterTasks([active, done], defaultFilters({ status: 'Done' })).map((t) => t.id)).toEqual(['ENG-2']);
    expect(filterTasks([active, done], defaultFilters({ assignee: 'Bob' })).map((t) => t.id)).toEqual(['ENG-2']);
    expect(filterTasks([active, done], defaultFilters({ priorities: new Set([3]) })).map((t) => t.id)).toEqual([
      'ENG-2',
    ]);
    expect(filterTasks([active, done], defaultFilters({ search: 'setup' })).map((t) => t.id)).toEqual(['ENG-2']);
  });
});

describe('groupTasks', () => {
  const active = makeTask({ id: 'ENG-1', assignee: 'Alice', priority: 'High', status: 'In Progress' });
  const doneSameAssignee = makeTask({
    id: 'ENG-2',
    assignee: 'Alice',
    priority: 'High',
    status: 'Done',
    statusType: 'completed',
  });

  it('returns one unified section when groupBy is none', () => {
    const groups = groupTasks([active, doneSameAssignee], 'none');
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('__all');
    expect(groups[0].tasks.map((t) => t.id)).toEqual(['ENG-1', 'ENG-2']);
  });

  it('groups active and completed tasks together by assignee and priority', () => {
    const byAssignee = groupTasks([active, doneSameAssignee], 'assignee');
    expect(byAssignee).toHaveLength(1);
    expect(byAssignee[0].label).toBe('Alice');
    expect(byAssignee[0].tasks.map((t) => t.id)).toEqual(['ENG-1', 'ENG-2']);

    const byPriority = groupTasks([active, doneSameAssignee], 'priority');
    expect(byPriority).toHaveLength(1);
    expect(byPriority[0].label).toBe('High');
    expect(byPriority[0].tasks.map((t) => t.id)).toEqual(['ENG-1', 'ENG-2']);
  });

  it('places completed tasks into their status group when groupBy is status', () => {
    const byStatus = groupTasks([active, doneSameAssignee], 'status');
    expect(byStatus.map((g) => g.label)).toEqual(['Done', 'In Progress']);
    expect(byStatus[0].tasks.map((t) => t.id)).toEqual(['ENG-2']);
    expect(byStatus[1].tasks.map((t) => t.id)).toEqual(['ENG-1']);
  });
});

describe('computeDepViolations', () => {
  const today = new Date('2026-05-06T00:00:00');

  it('flags an active blocked task starting on or before an active blocker due date', () => {
    const blocker = makeTask({ id: 'ENG-1', due: '2026-05-10', blocks: ['ENG-2'] });
    const blocked = makeTask({ id: 'ENG-2', startDate: '2026-05-08', due: '2026-05-15', blockedBy: ['ENG-1'] });

    const violations = computeDepViolations([blocker, blocked], today);
    expect(violations.get('ENG-2')).toEqual(['ENG-1']);
  });

  it('does not flag violations when the blocker or blocked task is completed', () => {
    const doneBlocker = makeTask({
      id: 'ENG-1',
      due: '2026-05-10',
      blocks: ['ENG-2'],
      status: 'Done',
      statusType: 'completed',
    });
    const activeBlocked = makeTask({ id: 'ENG-2', startDate: '2026-05-08', due: '2026-05-15', blockedBy: ['ENG-1'] });
    expect(computeDepViolations([doneBlocker, activeBlocked], today).size).toBe(0);

    const activeBlocker = makeTask({ id: 'ENG-3', due: '2026-05-10', blocks: ['ENG-4'] });
    const doneBlocked = makeTask({
      id: 'ENG-4',
      startDate: '2026-05-08',
      due: '2026-05-15',
      blockedBy: ['ENG-3'],
      status: 'Done',
      statusType: 'completed',
    });
    expect(computeDepViolations([activeBlocker, doneBlocked], today).size).toBe(0);
  });
  it('flags cross-project violations and skips unscheduled external tasks', () => {
    const extBlocker = makeTask({
      id: 'CTRL-1',
      due: '2026-05-12',
      blocks: ['ENG-2'],
      isExternal: true,
    });
    const localBlocked = makeTask({
      id: 'ENG-2',
      startDate: '2026-05-08',
      due: '2026-05-15',
      blockedBy: ['CTRL-1'],
    });
    const unscheduledExtBlocker = makeTask({
      id: 'CTRL-9',
      due: '2026-05-20',
      blocks: ['ENG-2'],
      isExternal: true,
      isUnscheduledExternal: true,
    });

    const violations = computeDepViolations([extBlocker, localBlocked, unscheduledExtBlocker], today);
    expect(violations.get('ENG-2')).toEqual(['CTRL-1']);
  });
});

describe('computeTaskStats', () => {
  it('counts active, inProgress, completed, and date span across unified tasks', () => {
    const t1 = makeTask({ id: 'ENG-1', startDate: '2026-05-01', due: '2026-05-04', statusType: 'completed' });
    const t2 = makeTask({ id: 'ENG-2', startDate: '2026-05-05', due: '2026-05-10', statusType: 'started' });
    const t3 = makeTask({ id: 'ENG-3', startDate: '2026-05-11', due: '2026-05-15', statusType: 'unstarted' });
    const t4 = makeTask({ id: 'ENG-4', startDate: null, due: '2026-05-12', statusType: 'canceled' });

    expect(computeTaskStats([t1, t2, t3, t4])).toEqual({
      active: 2,
      inProgress: 1,
      completed: 1,
      span: 14,
    });
  });
});
