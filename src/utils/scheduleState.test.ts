import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import { scheduleState, scheduleStateClass } from './scheduleState';

const TODAY = new Date(2026, 4, 10); // 10 May 2026

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'ENG-1',
    uuid: 'uuid-1',
    title: 'Sample task',
    description: '',
    due: '2026-05-20',
    startDate: null,
    priorityVal: 2,
    priority: 'High',
    status: 'Todo',
    statusType: 'unstarted',
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

describe('scheduleState', () => {
  it('maps the five states', () => {
    expect(scheduleState(makeTask({ statusType: 'completed' }), TODAY)).toBe('done');
    expect(scheduleState(makeTask({ due: '2026-05-09' }), TODAY)).toBe('overdue');
    expect(scheduleState(makeTask({ statusType: 'started' }), TODAY)).toBe('in-progress');
    expect(scheduleState(makeTask({ startDate: '2026-05-04' }), TODAY)).toBe('late-start');
    expect(scheduleState(makeTask({ startDate: '2026-05-12' }), TODAY)).toBe('not-started');
  });

  it('keeps a completed issue done even when it finished late', () => {
    const lateDone = makeTask({ statusType: 'completed', due: '2026-04-01', startDate: '2026-03-01' });
    expect(scheduleState(lateDone, TODAY)).toBe('done');
  });

  it('keeps a completed issue done when completedAt is set on another state type', () => {
    const done = makeTask({ statusType: 'started', completedAt: '2026-05-01T12:00:00Z', due: '2026-04-01' });
    expect(scheduleState(done, TODAY)).toBe('done');
  });

  it('shows an in-progress issue past its due date as overdue', () => {
    expect(scheduleState(makeTask({ statusType: 'started', due: '2026-05-09' }), TODAY)).toBe('overdue');
  });

  it('is not overdue on the due date itself', () => {
    expect(scheduleState(makeTask({ due: '2026-05-10' }), TODAY)).toBe('not-started');
    expect(scheduleState(makeTask({ due: '2026-05-10', statusType: 'started' }), TODAY)).toBe('in-progress');
  });

  it('never marks an issue without a start date as late to start', () => {
    expect(scheduleState(makeTask({ startDate: null, due: '2026-05-20' }), TODAY)).toBe('not-started');
    expect(scheduleState(makeTask({ startDate: null, statusType: 'backlog' }), TODAY)).toBe('not-started');
  });

  it('is not late to start on the start date itself', () => {
    expect(scheduleState(makeTask({ startDate: '2026-05-10' }), TODAY)).toBe('not-started');
  });

  it('does not mark a started issue as late to start', () => {
    expect(scheduleState(makeTask({ statusType: 'started', startDate: '2026-05-01' }), TODAY)).toBe('in-progress');
  });

  it('treats backlog, unstarted and triage alike as not started', () => {
    for (const statusType of ['backlog', 'unstarted', 'triage']) {
      expect(scheduleState(makeTask({ statusType }), TODAY)).toBe('not-started');
    }
  });

  it('names a bar class per state', () => {
    expect(scheduleStateClass('done')).toBe('bar-done');
    expect(scheduleStateClass('late-start')).toBe('bar-late-start');
  });
});
