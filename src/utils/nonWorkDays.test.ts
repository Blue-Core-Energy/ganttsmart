import { describe, expect, it, vi } from 'vitest';
import type { NonWorkDay, Task } from '@/types';
import {
  buildNonWorkSpans,
  formatNonWorkRange,
  isValidIsoDate,
  MAX_NON_WORK_RANGE_DAYS,
  parseNonWorkDayInput,
  planNonWorkDaySnap,
  saveScheduleSnap,
  sortNonWorkDays,
} from './nonWorkDays';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'ENG-1',
    uuid: 'uuid-1',
    title: 'Sample task',
    description: '',
    due: '2026-11-27',
    startDate: '2026-11-23',
    priorityVal: 2,
    priority: 'High',
    status: 'In Progress',
    statusType: 'started',
    assignee: 'Sam',
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

function entry(overrides: Partial<NonWorkDay> = {}): NonWorkDay {
  return {
    id: 'n1',
    label: 'Thanksgiving',
    startDate: '2026-11-26',
    endDate: '2026-11-26',
    assigneeName: null,
    ...overrides,
  };
}

describe('isValidIsoDate', () => {
  it('accepts real dates only', () => {
    expect(isValidIsoDate('2026-11-26')).toBe(true);
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isValidIsoDate('2026-02-29')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('26-11-26')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });
});

describe('parseNonWorkDayInput', () => {
  const base = { label: ' Thanksgiving ', startDate: '2026-11-26', endDate: '', assigneeName: null };

  it('makes a trimmed single-day company entry when the end date and assignee are blank', () => {
    expect(parseNonWorkDayInput(base)).toEqual({
      value: { label: 'Thanksgiving', startDate: '2026-11-26', endDate: '2026-11-26', assigneeName: null },
    });
    expect(parseNonWorkDayInput({ ...base, assigneeName: '  ' })).toMatchObject({ value: { assigneeName: null } });
  });

  it('keeps a range and a trimmed assignee', () => {
    expect(parseNonWorkDayInput({ ...base, label: 'Alex PTO', endDate: '2026-12-01', assigneeName: ' Alex ' })).toEqual(
      {
        value: { label: 'Alex PTO', startDate: '2026-11-26', endDate: '2026-12-01', assigneeName: 'Alex' },
      },
    );
  });

  it('rejects bad input with a message', () => {
    expect(parseNonWorkDayInput({ ...base, label: '   ' })).toHaveProperty('error');
    expect(parseNonWorkDayInput({ ...base, label: 'x'.repeat(201) })).toHaveProperty('error');
    expect(parseNonWorkDayInput({ ...base, startDate: '' })).toHaveProperty('error');
    expect(parseNonWorkDayInput({ ...base, endDate: '2026-11-25' })).toEqual({
      error: 'The end date cannot be before the start date.',
    });
    expect(parseNonWorkDayInput({ ...base, endDate: '2026-02-31' })).toHaveProperty('error');
    expect(parseNonWorkDayInput({ ...base, startDate: '2026-01-01', endDate: '2027-01-02' })).toHaveProperty('error');
  });

  it('rejects "Unassigned" as a person, in any case', () => {
    for (const name of ['Unassigned', ' unassigned ', 'UNASSIGNED']) {
      expect(parseNonWorkDayInput({ ...base, assigneeName: name })).toHaveProperty('error');
    }
  });

  it('allows a range of exactly the maximum length', () => {
    // 2028 is a leap year: Jan 1 – Dec 31 is exactly 366 days
    expect(MAX_NON_WORK_RANGE_DAYS).toBe(366);
    expect(parseNonWorkDayInput({ ...base, startDate: '2028-01-01', endDate: '2028-12-31' })).toHaveProperty('value');
    expect(parseNonWorkDayInput({ ...base, startDate: '2028-01-01', endDate: '2029-01-01' })).toHaveProperty('error');
  });
});

describe('sortNonWorkDays / formatNonWorkRange', () => {
  it('sorts by start date, then end date, then label', () => {
    const a = entry({ id: 'a', startDate: '2026-12-24', endDate: '2026-12-25', label: 'B' });
    const b = entry({ id: 'b', startDate: '2026-11-26', label: 'Z' });
    const c = entry({ id: 'c', startDate: '2026-12-24', endDate: '2026-12-24', label: 'A' });
    expect(sortNonWorkDays([a, b, c]).map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('formats single days and ranges', () => {
    expect(formatNonWorkRange(entry())).toBe('Nov 26, 2026');
    expect(formatNonWorkRange(entry({ endDate: '2026-11-27' }))).toBe('Nov 26, 2026 – Nov 27, 2026');
  });
});

describe('buildNonWorkSpans', () => {
  const chartStart = new Date('2026-11-23T00:00:00');
  const entries = [
    entry({ id: 'h', label: 'Thanksgiving' }),
    entry({ id: 'p', label: 'Alex PTO', startDate: '2026-11-24', endDate: '2026-11-25', assigneeName: 'Alex' }),
    entry({ id: 'old', label: 'Past', startDate: '2026-01-01', endDate: '2026-01-02' }),
    entry({ id: 'span', label: 'Shutdown', startDate: '2026-11-20', endDate: '2026-11-24' }),
  ];

  it('includes company days and only the matching assignee’s PTO, in chart offsets', () => {
    const sam = buildNonWorkSpans(entries, 'Sam', chartStart, 14);
    expect(sam.map((s) => s.id)).toEqual(['h', 'span']);
    expect(sam[0]).toEqual({ id: 'h', label: 'Thanksgiving', scope: 'company', offset: 3, days: 1 });

    const alex = buildNonWorkSpans(entries, 'Alex', chartStart, 14);
    expect(alex.map((s) => [s.id, s.scope, s.offset, s.days])).toEqual([
      ['h', 'company', 3, 1],
      ['p', 'pto', 1, 2],
      ['span', 'company', 0, 2], // clamped to the chart start
    ]);
  });

  it('shows only company days with no assignee, and clamps to the chart end', () => {
    expect(buildNonWorkSpans(entries, undefined, chartStart, 14).map((s) => s.id)).toEqual(['h', 'span']);
    expect(buildNonWorkSpans(entries, 'Sam', chartStart, 3).map((s) => s.id)).toEqual(['span']);
    const clamped = buildNonWorkSpans([entry({ startDate: '2026-11-24', endDate: '2026-12-30' })], null, chartStart, 7);
    expect(clamped).toEqual([{ id: 'n1', label: 'Thanksgiving', scope: 'company', offset: 1, days: 6 }]);
  });
});

describe('planNonWorkDaySnap', () => {
  const holiday = entry();

  it('moves a due date on the holiday forward to the next workday', () => {
    const task = makeTask({ due: '2026-11-26' });
    const plan = planNonWorkDaySnap([task], [holiday], holiday);
    expect(plan).toEqual([{ task, due: '2026-11-27' }]);
  });

  it('moves a start date forward and keeps a later due date', () => {
    const task = makeTask({ startDate: '2026-11-26', due: '2026-12-02' });
    expect(planNonWorkDaySnap([task], [holiday], holiday)).toEqual([{ task, startDate: '2026-11-27' }]);
  });

  it('skips the weekend after a Friday holiday', () => {
    const friday = entry({ startDate: '2026-11-27', endDate: '2026-11-27', label: 'Day after' });
    const task = makeTask({ due: '2026-11-27' });
    expect(planNonWorkDaySnap([task], [friday], friday)).toEqual([{ task, due: '2026-11-30' }]);
  });

  it('moves a one-day task on the holiday as a unit', () => {
    const task = makeTask({ startDate: '2026-11-26', due: '2026-11-26' });
    expect(planNonWorkDaySnap([task], [holiday], holiday)).toEqual([
      { task, startDate: '2026-11-27', due: '2026-11-27' },
    ]);
  });

  it('snaps past a multi-day shutdown, and never leaves start after due', () => {
    const shutdown = entry({ startDate: '2026-12-23', endDate: '2026-12-31', label: 'Shutdown' });
    const task = makeTask({ startDate: '2026-12-24', due: '2026-12-28' });
    expect(planNonWorkDaySnap([task], [shutdown], shutdown)).toEqual([
      { task, startDate: '2027-01-01', due: '2027-01-01' },
    ]);
  });

  it('only touches tasks that land on the new days', () => {
    const before = makeTask({ id: 'ENG-2', uuid: 'u2', startDate: '2026-11-23', due: '2026-11-25' });
    const after = makeTask({ id: 'ENG-3', uuid: 'u3', startDate: '2026-11-27', due: '2026-11-30' });
    const noStart = makeTask({ id: 'ENG-4', uuid: 'u4', startDate: null, due: '2026-11-26' });
    const plan = planNonWorkDaySnap([before, after, noStart], [holiday], holiday);
    expect(plan).toEqual([{ task: noStart, due: '2026-11-27' }]);
  });

  it('applies per-person PTO to that person’s tasks only, and avoids their other PTO', () => {
    const pto = entry({
      id: 'p',
      label: 'Alex PTO',
      startDate: '2026-11-24',
      endDate: '2026-11-25',
      assigneeName: 'Alex',
    });
    const alexTask = makeTask({
      id: 'ENG-5',
      uuid: 'u5',
      assignee: 'Alex',
      startDate: '2026-11-24',
      due: '2026-11-25',
    });
    const samTask = makeTask({ id: 'ENG-6', uuid: 'u6', assignee: 'Sam', startDate: '2026-11-24', due: '2026-11-25' });
    const plan = planNonWorkDaySnap([alexTask, samTask], [holiday, pto], pto);
    // Alex: Wed 25 is PTO and Thu 26 is Thanksgiving, so both land on Fri 27
    expect(plan).toEqual([{ task: alexTask, startDate: '2026-11-27', due: '2026-11-27' }]);
  });

  it('leaves completed, canceled-done and external tasks alone', () => {
    const done = makeTask({ id: 'D', uuid: 'd', statusType: 'completed', due: '2026-11-26' });
    const completedAt = makeTask({ id: 'C', uuid: 'c', completedAt: '2026-11-01T00:00:00Z', due: '2026-11-26' });
    const external = makeTask({ id: 'X', uuid: 'x', isExternal: true, due: '2026-11-26' });
    const canceled = makeTask({ id: 'K', uuid: 'k', statusType: 'canceled', due: '2026-11-26' });
    const plan = planNonWorkDaySnap([done, completedAt, external, canceled], [holiday], holiday);
    expect(plan).toEqual([{ task: canceled, due: '2026-11-27' }]);
  });

  it('does not change an implicit due date, nor push its start past it', () => {
    const implicitDue = makeTask({ startDate: '2026-11-23', due: '2026-11-26', isDueImplicit: true });
    expect(planNonWorkDaySnap([implicitDue], [holiday], holiday)).toEqual([]);

    const startOnHoliday = makeTask({ startDate: '2026-11-26', due: '2026-11-26', isDueImplicit: true });
    expect(planNonWorkDaySnap([startOnHoliday], [holiday], holiday)).toEqual([]);

    const roomToMove = makeTask({ startDate: '2026-11-26', due: '2026-12-10', isDueImplicit: true });
    expect(planNonWorkDaySnap([roomToMove], [holiday], holiday)).toEqual([
      { task: roomToMove, startDate: '2026-11-27' },
    ]);
  });
});

describe('saveScheduleSnap', () => {
  const snap = { task: makeTask(), startDate: '2026-11-30', due: '2026-12-01' };

  it('applies both fields when both save', async () => {
    const result = await saveScheduleSnap(
      snap,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
    );
    expect(result).toEqual({ applied: snap, failed: false });
  });

  it('keeps the due date and drops only the start date when the start save fails', async () => {
    const result = await saveScheduleSnap(
      snap,
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockRejectedValue(new Error('x')),
    );
    expect(result).toEqual({ applied: { task: snap.task, due: '2026-12-01' }, failed: true });
  });

  it('applies nothing and skips the start save when the due save fails', async () => {
    const saveStart = vi.fn();
    const result = await saveScheduleSnap(snap, vi.fn().mockRejectedValue(new Error('x')), saveStart);
    expect(result).toEqual({ applied: { task: snap.task }, failed: true });
    expect(saveStart).not.toHaveBeenCalled();
  });

  it('saves only the start date for a start-only snap', async () => {
    const saveDue = vi.fn();
    const saveStart = vi.fn().mockResolvedValue(undefined);
    const result = await saveScheduleSnap({ task: snap.task, startDate: '2026-11-30' }, saveDue, saveStart);
    expect(saveDue).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: { task: snap.task, startDate: '2026-11-30' }, failed: false });
  });
});
