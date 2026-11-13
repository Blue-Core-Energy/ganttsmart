export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

export function daysBetween(a: Date, b: Date): number {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86400000);
}

export function isWeekend(date: Date): boolean {
  const d = date.getDay();
  return d === 0 || d === 6;
}

/** Snap a weekend date to the next (direction = 1) or previous (direction = -1) weekday. */
export function snapToWorkday(date: Date, direction: 1 | -1): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  while (isWeekend(d)) {
    d.setDate(d.getDate() + direction);
  }
  return d;
}

/** Count Monday–Friday workdays between `start` and `end` inclusive. Returns 0 if `end < start`. */
export function countWorkdaysInclusive(start: Date, end: Date): number {
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  if (e < s) return 0;

  let count = 0;
  const cursor = new Date(s);
  while (cursor <= e) {
    if (!isWeekend(cursor)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

/**
 * Given a start date and a workday count (`>= 1`, inclusive of the first workday),
 * return the resulting end date skipping Saturdays and Sundays.
 */
export function addWorkdaysInclusive(start: Date, workdays: number): Date {
  const cursor = snapToWorkday(start, 1);
  let remaining = Math.max(0, workdays - 1);
  while (remaining > 0) {
    cursor.setDate(cursor.getDate() + 1);
    if (!isWeekend(cursor)) remaining--;
  }
  return cursor;
}

/**
 * Shift a task's `[start, due]` schedule by `calendarDeltaDays` while preserving
 * the task's Monday–Friday workday duration and skipping weekends.
 *
 * Example: Mon→Fri (5 workdays) moved +2 days starts on Wed and finishes on Tue
 * (Wed, Thu, Fri, Mon, Tue = 5 workdays) instead of landing on Sunday.
 */
export function moveTaskDatesPreservingWorkdays(
  start: Date,
  due: Date,
  calendarDeltaDays: number,
): { start: Date; due: Date; workdays: number } {
  const baseStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const baseDue = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const workdays = countWorkdaysInclusive(baseStart, baseDue);

  if (calendarDeltaDays === 0) {
    return { start: baseStart, due: baseDue, workdays };
  }

  // Inverted dates or weekend-only tasks keep calendar-day offset
  if (baseDue < baseStart || workdays === 0) {
    return {
      start: addDays(baseStart, calendarDeltaDays),
      due: addDays(baseDue, calendarDeltaDays),
      workdays,
    };
  }

  const rawStart = addDays(baseStart, calendarDeltaDays);
  const newStart = snapToWorkday(rawStart, calendarDeltaDays > 0 ? 1 : -1);
  const newDue = addWorkdaysInclusive(newStart, workdays);
  return { start: newStart, due: newDue, workdays };
}

/** Monday of the week containing the given date (local midnight preserved). */
export function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

export interface TimeCell {
  start: Date;
  days: number;
}

/**
 * Split the chart range into timeline cells for the given scale.
 * Day: one cell per day. Week: cells break on Mondays. Month: cells break on the 1st.
 * The first and last cells are clamped to the chart range, so widths always sum to totalDays.
 */
export function buildTimeCells(chartStart: Date, totalDays: number, scale: 'day' | 'week' | 'month'): TimeCell[] {
  const cells: TimeCell[] = [];
  if (scale === 'day') {
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(chartStart);
      d.setDate(d.getDate() + i);
      cells.push({ start: d, days: 1 });
    }
    return cells;
  }

  let cursor = new Date(chartStart);
  let remaining = totalDays;
  while (remaining > 0) {
    let next: Date;
    if (scale === 'week') {
      next = startOfWeek(cursor);
      next.setDate(next.getDate() + 7);
    } else {
      next = new Date(cursor);
      next.setDate(1);
      next.setMonth(next.getMonth() + 1);
    }
    const days = Math.min(daysBetween(cursor, next), remaining);
    cells.push({ start: cursor, days });
    cursor = next;
    remaining -= days;
  }
  return cells;
}
