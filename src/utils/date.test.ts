import { describe, expect, it } from 'vitest';
import {
  addDays,
  addWorkdaysInclusive,
  computeBarDayRange,
  countWorkdaysInclusive,
  daysBetween,
  formatIsoDate,
  moveTaskDatesPreservingWorkdays,
  snapToWorkday,
} from './date';

function d(iso: string): Date {
  return new Date(iso + 'T00:00:00');
}

describe('workday duration helpers', () => {
  it('countWorkdaysInclusive counts Mon–Fri days across single and multi-week spans', () => {
    // Mon Nov 9 -> Fri Nov 13 = 5 workdays
    expect(countWorkdaysInclusive(d('2026-11-09'), d('2026-11-13'))).toBe(5);
    // Wed Nov 11 -> Tue Nov 17 (across weekend) = 5 workdays
    expect(countWorkdaysInclusive(d('2026-11-11'), d('2026-11-17'))).toBe(5);
    // Mon Nov 9 -> Fri Nov 20 (across 1 weekend) = 10 workdays
    expect(countWorkdaysInclusive(d('2026-11-09'), d('2026-11-20'))).toBe(10);
    // Single workday
    expect(countWorkdaysInclusive(d('2026-11-09'), d('2026-11-09'))).toBe(1);
    // Weekend only
    expect(countWorkdaysInclusive(d('2026-11-14'), d('2026-11-15'))).toBe(0);
    // Inverted range
    expect(countWorkdaysInclusive(d('2026-11-13'), d('2026-11-09'))).toBe(0);
  });

  it('addWorkdaysInclusive skips Saturdays and Sundays', () => {
    expect(formatIsoDate(addWorkdaysInclusive(d('2026-11-09'), 5))).toBe('2026-11-13'); // Mon -> Fri
    expect(formatIsoDate(addWorkdaysInclusive(d('2026-11-11'), 5))).toBe('2026-11-17'); // Wed -> Tue
    expect(formatIsoDate(addWorkdaysInclusive(d('2026-11-11'), 10))).toBe('2026-11-24'); // Wed -> Tue (+2 wks)
    expect(formatIsoDate(addWorkdaysInclusive(d('2026-11-13'), 2))).toBe('2026-11-16'); // Fri -> Mon
    expect(formatIsoDate(addWorkdaysInclusive(d('2026-11-09'), 1))).toBe('2026-11-09'); // 1 workday = same day
  });

  it('snapToWorkday snaps weekend dates in the movement direction', () => {
    expect(formatIsoDate(snapToWorkday(d('2026-11-14'), 1))).toBe('2026-11-16'); // Sat -> Mon
    expect(formatIsoDate(snapToWorkday(d('2026-11-15'), 1))).toBe('2026-11-16'); // Sun -> Mon
    expect(formatIsoDate(snapToWorkday(d('2026-11-14'), -1))).toBe('2026-11-13'); // Sat -> Fri
    expect(formatIsoDate(snapToWorkday(d('2026-11-15'), -1))).toBe('2026-11-13'); // Sun -> Fri
    expect(formatIsoDate(snapToWorkday(d('2026-11-11'), 1))).toBe('2026-11-11'); // Wed unchanged
  });

  it('moveTaskDatesPreservingWorkdays handles the Mon–Fri +2d -> Wed–Tue example and inverse', () => {
    // Mon Nov 9 -> Fri Nov 13 moved +2 days right -> starts Wed Nov 11, ends Tue Nov 17
    const movedRight = moveTaskDatesPreservingWorkdays(d('2026-11-09'), d('2026-11-13'), 2);
    expect(formatIsoDate(movedRight.start)).toBe('2026-11-11');
    expect(formatIsoDate(movedRight.due)).toBe('2026-11-17');
    expect(movedRight.workdays).toBe(5);

    // Inverse: Wed Nov 11 -> Tue Nov 17 moved -2 days left -> Mon Nov 9 -> Fri Nov 13
    const movedLeft = moveTaskDatesPreservingWorkdays(movedRight.start, movedRight.due, -2);
    expect(formatIsoDate(movedLeft.start)).toBe('2026-11-09');
    expect(formatIsoDate(movedLeft.due)).toBe('2026-11-13');
    expect(movedLeft.workdays).toBe(5);
  });

  it('moveTaskDatesPreservingWorkdays preserves multi-week durations across multiple weekends', () => {
    // Mon Nov 9 -> Fri Nov 20 (10 workdays) moved +2 days -> Wed Nov 11 -> Tue Nov 24
    const res = moveTaskDatesPreservingWorkdays(d('2026-11-09'), d('2026-11-20'), 2);
    expect(formatIsoDate(res.start)).toBe('2026-11-11');
    expect(formatIsoDate(res.due)).toBe('2026-11-24');
    expect(countWorkdaysInclusive(res.start, res.due)).toBe(10);
  });

  it('moveTaskDatesPreservingWorkdays snaps weekend landing starts off Sat/Sun in drag direction', () => {
    // Mon Nov 9 -> Fri Nov 13 moved +5 days (raw start = Sat Nov 14) -> Mon Nov 16 -> Fri Nov 20
    const forward = moveTaskDatesPreservingWorkdays(d('2026-11-09'), d('2026-11-13'), 5);
    expect(formatIsoDate(forward.start)).toBe('2026-11-16');
    expect(formatIsoDate(forward.due)).toBe('2026-11-20');

    // Mon Nov 9 -> Fri Nov 13 moved -1 day (raw start = Sun Nov 8) -> Fri Nov 6 -> Thu Nov 12
    const backward = moveTaskDatesPreservingWorkdays(d('2026-11-09'), d('2026-11-13'), -1);
    expect(formatIsoDate(backward.start)).toBe('2026-11-06');
    expect(formatIsoDate(backward.due)).toBe('2026-11-12');
    expect(countWorkdaysInclusive(backward.start, backward.due)).toBe(5);
  });

  it('moveTaskDatesPreservingWorkdays keeps weekend-only tasks shifted by calendar days', () => {
    const res = moveTaskDatesPreservingWorkdays(d('2026-11-14'), d('2026-11-15'), 7);
    expect(formatIsoDate(res.start)).toBe('2026-11-21');
    expect(formatIsoDate(res.due)).toBe('2026-11-22');
    expect(res.workdays).toBe(0);
  });

  it('daysBetween handles DST transitions without off-by-one rounding errors', () => {
    // 2026-11-01 is US fall-back DST day (25 hours long)
    expect(daysBetween(d('2026-10-31'), d('2026-11-02'))).toBe(2);
    expect(formatIsoDate(addDays(d('2026-10-31'), 2))).toBe('2026-11-02');
  });

  it('computeBarDayRange ends overdue bars verbatim on dueDate instead of extending to today', () => {
    const chartStart = d('2026-10-01');
    const today = d('2026-11-13');
    const dayWidth = 28;

    // Overdue task with startDate (Oct 5 -> Oct 13): must end on Oct 13, NOT Nov 13
    const withStart = computeBarDayRange({
      chartStart,
      today,
      startDate: d('2026-10-05'),
      dueDate: d('2026-10-13'),
      isDone: false,
      dayWidth,
    });
    expect(withStart).toEqual({
      barLeft: 4 * dayWidth,
      barWidth: 9 * dayWidth, // Oct 5..Oct 13 inclusive
    });

    // Overdue task without startDate (due Oct 13): compact 2-day bar ending on Oct 13, NOT stretched to Nov 13
    const withoutStart = computeBarDayRange({
      chartStart,
      today,
      startDate: null,
      dueDate: d('2026-10-13'),
      isDone: false,
      dayWidth,
    });
    expect(withoutStart).toEqual({
      barLeft: 11 * dayWidth, // Oct 12
      barWidth: 2 * dayWidth, // Oct 12..Oct 13 (ends on Oct 13)
    });

    // Future active task without startDate (due Nov 16): runs today (Nov 13) -> Nov 16
    const futureWithoutStart = computeBarDayRange({
      chartStart,
      today,
      startDate: null,
      dueDate: d('2026-11-16'),
      isDone: false,
      dayWidth,
    });
    expect(futureWithoutStart).toEqual({
      barLeft: 43 * dayWidth, // Nov 13
      barWidth: 4 * dayWidth, // Nov 13..Nov 16
    });

    // Overdue without startDate on chartStart (day 0): clamped cleanly so right edge stays on dueDate
    const onChartStart = computeBarDayRange({
      chartStart,
      today,
      startDate: null,
      dueDate: d('2026-10-01'),
      isDone: false,
      dayWidth,
    });
    expect(onChartStart).toEqual({
      barLeft: 0,
      barWidth: dayWidth,
    });
  });
});
