import { describe, expect, it } from 'vitest';
import type { Filters, Task } from '@/types';
import {
  applyCollapsedParents,
  applyCustomOrder,
  buildTaskHierarchy,
  computeDepViolations,
  computeTaskStats,
  filterTasks,
  groupSubtasksUnderParents,
  hasActiveRowFilters,
  isTaskDone,
  mergeUnifiedTasks,
  reorderWithinHierarchy,
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

  it('filters completed tasks by status, assignee, and search', () => {
    expect(filterTasks([active, done], defaultFilters({ status: 'Done' })).map((t) => t.id)).toEqual(['ENG-2']);
    expect(filterTasks([active, done], defaultFilters({ assignee: 'Bob' })).map((t) => t.id)).toEqual(['ENG-2']);
    expect(filterTasks([active, done], defaultFilters({ search: 'setup' })).map((t) => t.id)).toEqual(['ENG-2']);
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

/** Task whose uuid mirrors its identifier ('ENG-1' -> 'u-ENG-1'), optionally under a parent */
function node(id: string, parentId?: string | null, overrides: Partial<Task> = {}): Task {
  return makeTask({ id, uuid: `u-${id}`, parentId, ...overrides });
}

const ids = (tasks: Task[]) => tasks.map((t) => t.id);

describe('buildTaskHierarchy', () => {
  it('returns the same array when nothing has a parent in the list', () => {
    const tasks = [node('A'), node('B'), node('C', 'MISSING')];
    const h = buildTaskHierarchy(tasks);
    expect(h.tasks).toBe(tasks);
    expect(h.parentById.size).toBe(0);
    expect(h.depthById.get('C')).toBe(0);
  });

  it('groups sub-issues directly under their parent and keeps the remaining order', () => {
    const tasks = [node('A'), node('A1', 'A'), node('B'), node('A2', 'A'), node('C')];
    // A1 was already under A, A2 is pulled up from after B
    expect(ids(groupSubtasksUnderParents(tasks))).toEqual(['A', 'A1', 'A2', 'B', 'C']);
  });

  it('places children listed before their parent beneath it and keeps sibling order', () => {
    const tasks = [node('A2', 'A'), node('B'), node('A1', 'A'), node('A')];
    expect(ids(groupSubtasksUnderParents(tasks))).toEqual(['B', 'A', 'A2', 'A1']);
  });

  it('nests multiple levels and reports depth, parents and direct children', () => {
    const tasks = [node('A'), node('B'), node('A1a', 'A1'), node('A1', 'A'), node('A2', 'A')];
    const h = buildTaskHierarchy(tasks);
    expect(ids(h.tasks)).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);
    expect(h.depthById.get('A')).toBe(0);
    expect(h.depthById.get('A1')).toBe(1);
    expect(h.depthById.get('A1a')).toBe(2);
    expect(h.parentById.get('A1a')).toBe('A1');
    expect(h.childIdsById.get('A')).toEqual(['A1', 'A2']);
    expect(h.childIdsById.get('B')).toBeUndefined();
  });

  it('treats a sub-issue whose parent is absent from the list as a top-level row', () => {
    const tasks = [node('A'), node('X1', 'X'), node('A1', 'A')];
    const h = buildTaskHierarchy(tasks);
    expect(ids(h.tasks)).toEqual(['A', 'A1', 'X1']);
    expect(h.depthById.get('X1')).toBe(0);
    expect(h.parentById.has('X1')).toBe(false);
  });

  it('never drops rows when parent links form a cycle or point at themselves', () => {
    const tasks = [node('A', 'B'), node('B', 'A'), node('C', 'C'), node('D')];
    const result = groupSubtasksUnderParents(tasks);
    expect(ids(result).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('composes with sortTasks so parents stay ahead of their children', () => {
    const parent = node('P', null, { priorityVal: 3, due: '2026-05-20' });
    const urgentChild = node('P1', 'P', { priorityVal: 1, due: '2026-05-01' });
    const other = node('O', null, { priorityVal: 2, due: '2026-05-10' });
    expect(ids(groupSubtasksUnderParents(sortTasks([parent, urgentChild, other])))).toEqual(['O', 'P', 'P1']);
  });
});

describe('applyCollapsedParents', () => {
  const tasks = [node('A'), node('A1', 'A'), node('A1a', 'A1'), node('A2', 'A'), node('B'), node('B1', 'B')];
  const hierarchy = buildTaskHierarchy(tasks);

  it('keeps every row when nothing is collapsed', () => {
    const { rows, hiddenInto } = applyCollapsedParents(hierarchy, new Set());
    expect(ids(rows)).toEqual(ids(hierarchy.tasks));
    expect(hiddenInto.size).toBe(0);
  });

  it('hides the descendants of a collapsed parent and maps them to it', () => {
    const { rows, hiddenInto } = applyCollapsedParents(hierarchy, new Set(['A']));
    expect(ids(rows)).toEqual(['A', 'B', 'B1']);
    expect([...hiddenInto]).toEqual([
      ['A1', 'A'],
      ['A1a', 'A'],
      ['A2', 'A'],
    ]);
  });

  it('maps grandchildren to the outermost collapsed ancestor', () => {
    const { rows, hiddenInto } = applyCollapsedParents(hierarchy, new Set(['A1', 'A']));
    expect(ids(rows)).toEqual(['A', 'B', 'B1']);
    expect(hiddenInto.get('A1a')).toBe('A');
  });

  it('only hides the collapsed branch when a nested parent is collapsed', () => {
    const { rows, hiddenInto } = applyCollapsedParents(hierarchy, new Set(['A1']));
    expect(ids(rows)).toEqual(['A', 'A1', 'A2', 'B', 'B1']);
    expect(hiddenInto.get('A1a')).toBe('A1');
  });

  it('ignores collapsed ids that are not parents in the list', () => {
    const { rows } = applyCollapsedParents(hierarchy, new Set(['GONE', 'A2']));
    expect(ids(rows)).toEqual(ids(hierarchy.tasks));
  });
});

describe('hasActiveRowFilters', () => {
  it('is true for search, assignee or status and ignores whitespace-only search', () => {
    expect(hasActiveRowFilters(defaultFilters())).toBe(false);
    expect(hasActiveRowFilters(defaultFilters({ search: '   ' }))).toBe(false);
    expect(hasActiveRowFilters(defaultFilters({ search: 'x' }))).toBe(true);
    expect(hasActiveRowFilters(defaultFilters({ assignee: 'Alice' }))).toBe(true);
    expect(hasActiveRowFilters(defaultFilters({ status: 'Todo' }))).toBe(true);
    expect(hasActiveRowFilters(defaultFilters({ showCompleted: false }))).toBe(false);
  });
});

describe('filterTasks with hierarchy', () => {
  it('keeps a matching sub-issue as a top-level row when its parent is filtered out', () => {
    const tasks = [node('A', null, { title: 'Parent' }), node('A1', 'A', { title: 'Needle child' })];
    const matches = filterTasks(tasks, defaultFilters({ search: 'needle' }));
    const h = buildTaskHierarchy(matches);
    expect(ids(h.tasks)).toEqual(['A1']);
    expect(h.depthById.get('A1')).toBe(0);
  });
});

describe('reorderWithinHierarchy', () => {
  const tasks = [node('A'), node('A1', 'A'), node('A2', 'A'), node('B'), node('B1', 'B'), node('C')];
  const uuids = (order: string[] | null) => order?.map((u) => u.replace('u-', ''));

  it('moves a parent together with its sub-issues', () => {
    expect(uuids(reorderWithinHierarchy(tasks, 'u-A', 'u-C', true))).toEqual(['B', 'B1', 'C', 'A', 'A1', 'A2']);
    expect(uuids(reorderWithinHierarchy(tasks, 'u-B', 'u-A', false))).toEqual(['B', 'B1', 'A', 'A1', 'A2', 'C']);
  });

  it('resolves a drop on a nested row to the sibling block that contains it', () => {
    expect(uuids(reorderWithinHierarchy(tasks, 'u-C', 'u-A1', false))).toEqual(['C', 'A', 'A1', 'A2', 'B', 'B1']);
    expect(uuids(reorderWithinHierarchy(tasks, 'u-C', 'u-A1', true))).toEqual(['A', 'A1', 'A2', 'C', 'B', 'B1']);
  });

  it('reorders a sub-issue among its siblings only', () => {
    expect(uuids(reorderWithinHierarchy(tasks, 'u-A2', 'u-A1', false))).toEqual(['A', 'A2', 'A1', 'B', 'B1', 'C']);
    expect(uuids(reorderWithinHierarchy(tasks, 'u-A1', 'u-A2', true))).toEqual(['A', 'A2', 'A1', 'B', 'B1', 'C']);
  });

  it('refuses to move a sub-issue across a parent boundary', () => {
    expect(reorderWithinHierarchy(tasks, 'u-A1', 'u-B', false)).toBeNull();
    expect(reorderWithinHierarchy(tasks, 'u-A1', 'u-B1', true)).toBeNull();
    expect(reorderWithinHierarchy(tasks, 'u-A1', 'u-A', true)).toBeNull();
  });

  it('refuses to drop a parent into its own subtree and ignores unknown or identical rows', () => {
    expect(reorderWithinHierarchy(tasks, 'u-A', 'u-A1', true)).toBeNull();
    expect(reorderWithinHierarchy(tasks, 'u-A', 'u-A', true)).toBeNull();
    expect(reorderWithinHierarchy(tasks, 'u-A', 'u-nope', true)).toBeNull();
  });

  it('behaves like a plain move for flat lists', () => {
    const flat = [node('X'), node('Y'), node('Z')];
    expect(uuids(reorderWithinHierarchy(flat, 'u-X', 'u-Z', true))).toEqual(['Y', 'Z', 'X']);
    expect(uuids(reorderWithinHierarchy(flat, 'u-Z', 'u-X', false))).toEqual(['Z', 'X', 'Y']);
  });

  it('keeps nested subtrees intact when moving a mid-level parent among its siblings', () => {
    const deep = [node('A'), node('A1', 'A'), node('A1a', 'A1'), node('A2', 'A')];
    expect(uuids(reorderWithinHierarchy(deep, 'u-A1', 'u-A2', true))).toEqual(['A', 'A2', 'A1', 'A1a']);
  });
});
