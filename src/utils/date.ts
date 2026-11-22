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

/** A custom non-work day or range (inclusive, `YYYY-MM-DD`). Without `assigneeName` it applies to everyone. */
export interface NonWorkDayRange {
  startDate: string;
  endDate: string;
  assigneeName?: string | null;
}

/**
 * Which custom non-work days apply to a calculation: every company-wide entry plus the PTO entries
 * whose `assigneeName` equals `assignee`. Omit the calendar (or pass no entries) for plain
 * Monday–Friday math.
 */
export interface WorkCalendar {
  entries: readonly NonWorkDayRange[];
  assignee?: string | null;
}

/**
 * Upper bound on how far the workday helpers walk looking for a workday. An absurd run of
 * consecutive non-work days (e.g. a range covering decades) then falls back to Monday–Friday
 * instead of looping for ages.
 */
export const MAX_NON_WORK_SCAN_DAYS = 3660;

/** Whether a custom entry (not the weekend) takes `isoDate` off for a person. */
export function entryAppliesTo(entry: NonWorkDayRange, isoDate: string, assignee?: string | null): boolean {
  if (isoDate < entry.startDate || isoDate > entry.endDate) return false;
  if (!entry.assigneeName) return true;
  return entry.assigneeName.trim().toLowerCase() === (assignee ?? '').trim().toLowerCase();
}

/** Whether `date` is a weekend or falls in a company-wide / matching per-assignee non-work entry. */
export function isNonWorkDay(date: Date, calendar?: WorkCalendar): boolean {
  if (isWeekend(date)) return true;
  if (!calendar || calendar.entries.length === 0) return false;
  const iso = formatIsoDate(date);
  return calendar.entries.some((e) => entryAppliesTo(e, iso, calendar.assignee));
}

/**
 * Walks `d` (mutated) by `direction` until it is a workday. If the custom calendar blocks more
 * than MAX_NON_WORK_SCAN_DAYS in a row, it settles for the next Monday–Friday instead.
 */
function seekWorkday(d: Date, direction: 1 | -1, calendar?: WorkCalendar): void {
  const origin = new Date(d);
  for (let i = 0; i <= MAX_NON_WORK_SCAN_DAYS; i++) {
    if (!isNonWorkDay(d, calendar)) return;
    d.setDate(d.getDate() + direction);
  }
  d.setTime(origin.getTime());
  while (isWeekend(d)) d.setDate(d.getDate() + direction);
}

/**
 * Snap a non-work date (weekend, holiday or the assignee's PTO) to the next (direction = 1) or
 * previous (direction = -1) workday.
 */
export function snapToWorkday(date: Date, direction: 1 | -1, calendar?: WorkCalendar): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  seekWorkday(d, direction, calendar);
  return d;
}

/** Count workdays between `start` and `end` inclusive. Returns 0 if `end < start`. */
export function countWorkdaysInclusive(start: Date, end: Date, calendar?: WorkCalendar): number {
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  if (e < s) return 0;

  let count = 0;
  const cursor = new Date(s);
  while (cursor <= e) {
    if (!isNonWorkDay(cursor, calendar)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

/**
 * Given a start date and a workday count (`>= 1`, inclusive of the first workday),
 * return the resulting end date skipping weekends and any non-work days in `calendar`.
 */
export function addWorkdaysInclusive(start: Date, workdays: number, calendar?: WorkCalendar): Date {
  const cursor = snapToWorkday(start, 1, calendar);
  let remaining = Math.max(0, workdays - 1);
  let blockedRun = 0;
  while (remaining > 0) {
    cursor.setDate(cursor.getDate() + 1);
    if (isNonWorkDay(cursor, calendar)) {
      // An absurd run of blocked days: redo the count with Monday–Friday only
      if (++blockedRun > MAX_NON_WORK_SCAN_DAYS) return addWorkdaysInclusive(start, workdays);
    } else {
      blockedRun = 0;
      remaining--;
    }
  }
  return cursor;
}

/**
 * Shift a task's `[start, due]` schedule by `calendarDeltaDays` while preserving
 * the task's workday duration and skipping weekends (and holidays / PTO in `calendar`).
 *
 * Example: Mon→Fri (5 workdays) moved +2 days starts on Wed and finishes on Tue
 * (Wed, Thu, Fri, Mon, Tue = 5 workdays) instead of landing on Sunday.
 */
export function moveTaskDatesPreservingWorkdays(
  start: Date,
  due: Date,
  calendarDeltaDays: number,
  calendar?: WorkCalendar,
): { start: Date; due: Date; workdays: number } {
  const baseStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const baseDue = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const workdays = countWorkdaysInclusive(baseStart, baseDue, calendar);

  if (calendarDeltaDays === 0) {
    return { start: baseStart, due: baseDue, workdays };
  }

  // Inverted dates or tasks made only of non-work days keep calendar-day offset
  if (baseDue < baseStart || workdays === 0) {
    return {
      start: addDays(baseStart, calendarDeltaDays),
      due: addDays(baseDue, calendarDeltaDays),
      workdays,
    };
  }

  const rawStart = addDays(baseStart, calendarDeltaDays);
  const newStart = snapToWorkday(rawStart, calendarDeltaDays > 0 ? 1 : -1, calendar);
  const newDue = addWorkdaysInclusive(newStart, workdays, calendar);
  return { start: newStart, due: newDue, workdays };
}

/**
 * Compute horizontal Gantt bar pixel range (`barLeft`, `barWidth`) from a task's dates.
 * Overdue tasks render verbatim ending on `dueDate` rather than extending to `today`.
 */
export function computeBarDayRange({
  chartStart,
  today,
  dueDate,
  startDate,
  isDone,
  dayWidth,
}: {
  chartStart: Date;
  today: Date;
  dueDate: Date;
  startDate: Date | null;
  isDone: boolean;
  dayWidth: number;
}): { barLeft: number; barWidth: number } {
  const overdue = daysBetween(today, dueDate) < 0;

  let barLeft: number;
  let barWidth: number;
  if (startDate) {
    const startDay = daysBetween(chartStart, startDate);
    const endDay = daysBetween(chartStart, dueDate);
    barLeft = startDay * dayWidth;
    barWidth = Math.max((endDay - startDay + 1) * dayWidth, dayWidth);
  } else if (isDone || overdue) {
    // Completed or overdue without an explicit start date: anchor a compact bar ending on dueDate
    const endDay = daysBetween(chartStart, dueDate);
    barLeft = (endDay - 1) * dayWidth;
    barWidth = Math.max(2 * dayWidth, dayWidth);
  } else {
    const barStartDay = daysBetween(chartStart, today);
    const barEndDay = daysBetween(chartStart, dueDate);
    barLeft = barStartDay * dayWidth;
    barWidth = Math.max((barEndDay - barStartDay + 1) * dayWidth, dayWidth);
  }

  if (barLeft < 0) {
    barWidth = Math.max(barWidth + barLeft, dayWidth);
    barLeft = 0;
  }

  return { barLeft, barWidth };
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
