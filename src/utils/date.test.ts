import { describe, expect, it } from 'vitest';
import {
  addDays,
  addWorkdaysInclusive,
  computeBarDayRange,
  countWorkdaysInclusive,
  daysBetween,
  entryAppliesTo,
  formatIsoDate,
  isNonWorkDay,
  MAX_NON_WORK_SCAN_DAYS,
  moveTaskDatesPreservingWorkdays,
  snapToWorkday,
  type WorkCalendar,
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

describe('custom non-work days (holidays and PTO)', () => {
  // Nov 2026: Thu 26 is Thanksgiving; Alex is out Mon 16 – Tue 17
  const calendar: WorkCalendar = {
    entries: [
      { startDate: '2026-11-26', endDate: '2026-11-26' },
      { startDate: '2026-11-16', endDate: '2026-11-17', assigneeName: 'Alex' },
    ],
    assignee: 'Sam',
  };
  const alex: WorkCalendar = { ...calendar, assignee: 'Alex' };

  it('entryAppliesTo matches company-wide entries for everyone and PTO only for the named assignee', () => {
    const holiday = { startDate: '2026-11-26', endDate: '2026-11-27' };
    expect(entryAppliesTo(holiday, '2026-11-26', null)).toBe(true);
    expect(entryAppliesTo(holiday, '2026-11-27', 'Anyone')).toBe(true);
    expect(entryAppliesTo(holiday, '2026-11-28', 'Anyone')).toBe(false);
    expect(entryAppliesTo(holiday, '2026-11-25', 'Anyone')).toBe(false);

    const pto = { startDate: '2026-11-16', endDate: '2026-11-17', assigneeName: 'Alex' };
    expect(entryAppliesTo(pto, '2026-11-16', 'Alex')).toBe(true);
    expect(entryAppliesTo(pto, '2026-11-17', 'Sam')).toBe(false);
    expect(entryAppliesTo(pto, '2026-11-17', null)).toBe(false);
    expect(entryAppliesTo(pto, '2026-11-18', 'Alex')).toBe(false);
  });

  it('isNonWorkDay keeps weekends and adds holidays and the matching assignee PTO', () => {
    expect(isNonWorkDay(d('2026-11-14'))).toBe(true); // Sat, no calendar
    expect(isNonWorkDay(d('2026-11-26'))).toBe(false); // Thu, no calendar: backward compatible
    expect(isNonWorkDay(d('2026-11-26'), calendar)).toBe(true);
    expect(isNonWorkDay(d('2026-11-14'), calendar)).toBe(true);
    expect(isNonWorkDay(d('2026-11-16'), calendar)).toBe(false); // Alex's PTO is not Sam's
    expect(isNonWorkDay(d('2026-11-16'), alex)).toBe(true);
    expect(isNonWorkDay(d('2026-11-18'), alex)).toBe(false);
    expect(isNonWorkDay(d('2026-11-16'), { entries: calendar.entries })).toBe(false); // unassigned
  });

  it('snapToWorkday skips holidays, PTO and the weekend after them in either direction', () => {
    expect(formatIsoDate(snapToWorkday(d('2026-11-26'), 1, calendar))).toBe('2026-11-27'); // Thu -> Fri
    expect(formatIsoDate(snapToWorkday(d('2026-11-26'), -1, calendar))).toBe('2026-11-25');
    expect(formatIsoDate(snapToWorkday(d('2026-11-16'), 1, alex))).toBe('2026-11-18');
    expect(formatIsoDate(snapToWorkday(d('2026-11-17'), -1, alex))).toBe('2026-11-13'); // over the weekend
    expect(formatIsoDate(snapToWorkday(d('2026-11-16'), 1, calendar))).toBe('2026-11-16');

    const longWeekend: WorkCalendar = { entries: [{ startDate: '2026-11-27', endDate: '2026-11-27' }] };
    expect(formatIsoDate(snapToWorkday(d('2026-11-27'), 1, longWeekend))).toBe('2026-11-30'); // Fri off -> Mon
  });

  it('countWorkdaysInclusive excludes holidays and only the assignee’s own PTO', () => {
    // Mon Nov 23 -> Fri Nov 27, Thanksgiving on Thu
    expect(countWorkdaysInclusive(d('2026-11-23'), d('2026-11-27'))).toBe(5);
    expect(countWorkdaysInclusive(d('2026-11-23'), d('2026-11-27'), calendar)).toBe(4);
    // Mon Nov 16 -> Fri Nov 20: Alex loses two days, Sam none
    expect(countWorkdaysInclusive(d('2026-11-16'), d('2026-11-20'), alex)).toBe(3);
    expect(countWorkdaysInclusive(d('2026-11-16'), d('2026-11-20'), calendar)).toBe(5);
    expect(countWorkdaysInclusive(d('2026-11-26'), d('2026-11-26'), calendar)).toBe(0);
  });

  it('addWorkdaysInclusive skips the holiday when counting out the duration', () => {
    // 3 workdays from Tue Nov 24: Tue, Wed, (Thu off) Fri
    expect(formatIsoDate(addWorkdaysInclusive(d('2026-11-24'), 3))).toBe('2026-11-26');
    expect(formatIsoDate(addWorkdaysInclusive(d('2026-11-24'), 3, calendar))).toBe('2026-11-27');
    // A start on the holiday begins on the next workday
    expect(formatIsoDate(addWorkdaysInclusive(d('2026-11-26'), 1, calendar))).toBe('2026-11-27');
    // Alex's PTO pushes the first day to Wednesday
    expect(formatIsoDate(addWorkdaysInclusive(d('2026-11-16'), 2, alex))).toBe('2026-11-19');
  });

  it('moveTaskDatesPreservingWorkdays keeps the workday count around holidays and PTO', () => {
    // Mon Nov 16 -> Wed Nov 18 (3 workdays for Sam) moved +7d lands Mon Nov 23 -> Wed Nov 25
    const plain = moveTaskDatesPreservingWorkdays(d('2026-11-16'), d('2026-11-18'), 7, calendar);
    expect(formatIsoDate(plain.start)).toBe('2026-11-23');
    expect(formatIsoDate(plain.due)).toBe('2026-11-25');

    // Moved +8d the three workdays straddle Thanksgiving: Tue, Wed, (Thu off) Fri
    const over = moveTaskDatesPreservingWorkdays(d('2026-11-16'), d('2026-11-18'), 8, calendar);
    expect(over.workdays).toBe(3);
    expect(formatIsoDate(over.start)).toBe('2026-11-24');
    expect(formatIsoDate(over.due)).toBe('2026-11-27');

    // Dropped onto the holiday the start snaps forward, in the drag direction
    const onto = moveTaskDatesPreservingWorkdays(d('2026-11-19'), d('2026-11-20'), 7, calendar);
    expect(formatIsoDate(onto.start)).toBe('2026-11-27');
    expect(formatIsoDate(onto.due)).toBe('2026-11-30');
    const back = moveTaskDatesPreservingWorkdays(d('2026-11-30'), d('2026-12-01'), -4, calendar);
    expect(formatIsoDate(back.start)).toBe('2026-11-25');

    // Alex's three-day task counts only the days Alex works
    const alexMove = moveTaskDatesPreservingWorkdays(d('2026-11-18'), d('2026-11-20'), 0, alex);
    expect(alexMove.workdays).toBe(3);
  });

  it('keeps the default behaviour when no calendar or an empty one is passed', () => {
    expect(countWorkdaysInclusive(d('2026-11-23'), d('2026-11-27'), { entries: [] })).toBe(5);
    const a = moveTaskDatesPreservingWorkdays(d('2026-11-09'), d('2026-11-13'), 2);
    const b = moveTaskDatesPreservingWorkdays(d('2026-11-09'), d('2026-11-13'), 2, { entries: [] });
    expect(b).toEqual(a);
  });

  it('does not loop forever when the calendar blocks an absurd run of days', () => {
    const forever: WorkCalendar = { entries: [{ startDate: '1900-01-01', endDate: '2999-12-31' }] };
    // Falls back to plain Monday–Friday once the scan limit is hit
    expect(formatIsoDate(snapToWorkday(d('2026-11-14'), 1, forever))).toBe('2026-11-16');
    expect(formatIsoDate(snapToWorkday(d('2026-11-14'), -1, forever))).toBe('2026-11-13');
    expect(formatIsoDate(addWorkdaysInclusive(d('2026-11-09'), 5, forever))).toBe('2026-11-13');

    // A long block still under the limit is honoured
    const start = d('2026-11-16');
    const end = addDays(start, MAX_NON_WORK_SCAN_DAYS - 30);
    const long: WorkCalendar = { entries: [{ startDate: formatIsoDate(start), endDate: formatIsoDate(end) }] };
    const snapped = snapToWorkday(start, 1, long);
    expect(snapped.getTime()).toBeGreaterThan(end.getTime());
    expect(isNonWorkDay(snapped, long)).toBe(false);
  });
});
