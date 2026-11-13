import { describe, expect, it } from 'vitest';
import type { Filters, Task } from '@/types';
import { filterExternalTasks, mergeTasksWithExternalOrder, pruneUnlinkedExternalTasks } from './crossProject';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    uuid: overrides.uuid ?? `uuid-${overrides.id}`,
    title: `Task ${overrides.id}`,
    description: '',
    due: '2026-05-10',
    startDate: null,
    priorityVal: 2,
    priority: 'High',
    status: 'Todo',
    statusType: 'unstarted',
    assignee: 'Alice',
    url: `https://linear.app/test/issue/${overrides.id}`,
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

describe('mergeTasksWithExternalOrder', () => {
  it('places external blockers directly above the local task they block and external blocked tasks directly below', () => {
    const local1 = makeTask({ id: 'ENG-1', blockedBy: ['CTRL-1'], blocks: ['COMM-1'] });
    const local2 = makeTask({ id: 'ENG-2' });
    const extBlocker = makeTask({
      id: 'CTRL-1',
      isExternal: true,
      projectId: 'proj-ctrl',
      projectName: 'Controls',
      blocks: ['ENG-1'],
    });
    const extBlocked = makeTask({
      id: 'COMM-1',
      isExternal: true,
      projectId: 'proj-comm',
      projectName: 'Commissioning',
      blockedBy: ['ENG-1'],
    });

    const ordered = mergeTasksWithExternalOrder([local1, local2], [extBlocked, extBlocker], []);
    expect(ordered.map((t) => t.id)).toEqual(['CTRL-1', 'ENG-1', 'COMM-1', 'ENG-2']);
  });

  it('keeps multiple unpositioned external tasks sorted around their linked local task', () => {
    const local1 = makeTask({ id: 'ENG-1', blockedBy: ['CTRL-2', 'CTRL-1'], blocks: ['COMM-2', 'COMM-1'] });
    const extBlocker1 = makeTask({
      id: 'CTRL-1',
      priorityVal: 1,
      isExternal: true,
      blocks: ['ENG-1'],
    });
    const extBlocker2 = makeTask({
      id: 'CTRL-2',
      priorityVal: 3,
      isExternal: true,
      blocks: ['ENG-1'],
    });
    const extBlocked1 = makeTask({
      id: 'COMM-1',
      priorityVal: 1,
      isExternal: true,
      blockedBy: ['ENG-1'],
    });
    const extBlocked2 = makeTask({
      id: 'COMM-2',
      priorityVal: 3,
      isExternal: true,
      blockedBy: ['ENG-1'],
    });

    const ordered = mergeTasksWithExternalOrder([local1], [extBlocker2, extBlocked2, extBlocker1, extBlocked1], []);
    expect(ordered.map((t) => t.id)).toEqual(['CTRL-1', 'CTRL-2', 'ENG-1', 'COMM-1', 'COMM-2']);
  });

  it('respects customOrder when ghost rows have been manually moved up or down', () => {
    const local1 = makeTask({ id: 'ENG-1', blockedBy: ['CTRL-1'] });
    const local2 = makeTask({ id: 'ENG-2' });
    const ext = makeTask({ id: 'CTRL-1', isExternal: true, blocks: ['ENG-1'] });

    // User moved CTRL-1 down to the bottom below ENG-2
    const ordered = mergeTasksWithExternalOrder([local1, local2], [ext], ['uuid-ENG-1', 'uuid-ENG-2', 'uuid-CTRL-1']);
    expect(ordered.map((t) => t.id)).toEqual(['ENG-1', 'ENG-2', 'CTRL-1']);
  });

  it('slots newly added external tasks inline even when local tasks already have a customOrder', () => {
    const local1 = makeTask({ id: 'ENG-1' });
    const local2 = makeTask({ id: 'ENG-2', blockedBy: ['CTRL-1'] });
    const ext = makeTask({ id: 'CTRL-1', isExternal: true, blocks: ['ENG-2'] });

    // User previously reordered ENG-2 above ENG-1; CTRL-1 is new and not in customOrder
    const ordered = mergeTasksWithExternalOrder([local1, local2], [ext], ['uuid-ENG-2', 'uuid-ENG-1']);
    expect(ordered.map((t) => t.id)).toEqual(['CTRL-1', 'ENG-2', 'ENG-1']);
  });

  it('returns local tasks in customOrder when there are no external tasks', () => {
    const local1 = makeTask({ id: 'ENG-1' });
    const local2 = makeTask({ id: 'ENG-2' });
    const ordered = mergeTasksWithExternalOrder([local1, local2], [], ['uuid-ENG-2', 'uuid-ENG-1']);
    expect(ordered.map((t) => t.id)).toEqual(['ENG-2', 'ENG-1']);
  });
});

describe('filterExternalTasks', () => {
  const localAlice = makeTask({ id: 'ENG-1', assignee: 'Alice', blockedBy: ['CTRL-1'] });
  const localBob = makeTask({ id: 'ENG-2', assignee: 'Bob', blocks: ['COMM-1'] });
  const extBlocker = makeTask({
    id: 'CTRL-1',
    title: 'Wire PLC cabinet',
    assignee: 'Carol',
    projectName: 'Controls',
    isExternal: true,
    blocks: ['ENG-1'],
  });
  const extDone = makeTask({
    id: 'COMM-1',
    title: 'Sign off checklist',
    assignee: 'Dan',
    projectName: 'Commissioning',
    status: 'Done',
    statusType: 'completed',
    completedAt: '2026-05-01T00:00:00Z',
    isExternal: true,
    blockedBy: ['ENG-2'],
  });

  it('returns empty array when showExternal is false', () => {
    expect(filterExternalTasks([extBlocker, extDone], [localAlice, localBob], defaultFilters(), false)).toEqual([]);
  });

  it('keeps external task visible only when linked to a visible local task (or matching search)', () => {
    // Only Alice's local task is visible -> CTRL-1 stays visible, COMM-1 is hidden
    const visible = filterExternalTasks([extBlocker, extDone], [localAlice], defaultFilters(), true);
    expect(visible.map((t) => t.id)).toEqual(['CTRL-1']);

    // Direct search on external project/title surfaces matching external task
    const searchMatch = filterExternalTasks([extBlocker, extDone], [], defaultFilters({ search: 'Controls' }), true);
    expect(searchMatch.map((t) => t.id)).toEqual(['CTRL-1']);
  });

  it('hides completed external tasks when showCompleted is false', () => {
    const visible = filterExternalTasks(
      [extBlocker, extDone],
      [localAlice, localBob],
      defaultFilters({ showCompleted: false }),
      true,
    );
    expect(visible.map((t) => t.id)).toEqual(['CTRL-1']);
  });
});

describe('pruneUnlinkedExternalTasks', () => {
  it('removes external tasks with no remaining links to local tasks', () => {
    const local1 = makeTask({ id: 'ENG-1', blockedBy: ['CTRL-1'] });
    const extLinked = makeTask({ id: 'CTRL-1', isExternal: true, blocks: ['ENG-1'] });
    const extOrphan = makeTask({ id: 'COMM-9', isExternal: true, blockedBy: [] });

    expect(pruneUnlinkedExternalTasks([extLinked, extOrphan], [local1]).map((t) => t.id)).toEqual(['CTRL-1']);
  });
});
