import type { NewNonWorkDay, NonWorkDay, Task } from '@/types';
import { daysBetween, entryAppliesTo, formatDateShort, formatIsoDate, snapToWorkday, type WorkCalendar } from './date';
import { isTaskDone } from './tasks';

/** Matches the server's limits (server/src/routes/nonWorkDays.ts). */
export const MAX_NON_WORK_LABEL_LENGTH = 200;
export const MAX_NON_WORK_RANGE_DAYS = 366;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written `YYYY-MM-DD` (rejects `2026-02-30`). */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(value + 'T00:00:00');
  return !Number.isNaN(d.getTime()) && formatIsoDate(d) === value;
}

/**
 * Validates and tidies form input. A blank end date makes a single-day entry and a blank assignee
 * makes it company-wide. Returns `{ error }` with a message fit to show the user.
 */
export function parseNonWorkDayInput(input: {
  label: string;
  startDate: string;
  endDate: string;
  assigneeName: string | null;
}): { value: NewNonWorkDay } | { error: string } {
  const label = input.label.trim();
  if (!label) return { error: 'Give the entry a name, like "Thanksgiving" or "Alex PTO".' };
  if (label.length > MAX_NON_WORK_LABEL_LENGTH) {
    return { error: `Keep the name under ${MAX_NON_WORK_LABEL_LENGTH} characters.` };
  }
  if (!isValidIsoDate(input.startDate)) return { error: 'Pick a valid start date.' };
  const endDate = input.endDate || input.startDate;
  if (!isValidIsoDate(endDate)) return { error: 'Pick a valid end date.' };
  if (endDate < input.startDate) return { error: 'The end date cannot be before the start date.' };
  const span = daysBetween(new Date(input.startDate + 'T00:00:00'), new Date(endDate + 'T00:00:00')) + 1;
  if (span > MAX_NON_WORK_RANGE_DAYS) {
    return { error: `A single entry can cover at most ${MAX_NON_WORK_RANGE_DAYS} days. Split it into several.` };
  }
  const assigneeName = input.assigneeName?.trim() || null;
  if (assigneeName?.toLowerCase() === 'unassigned') {
    return { error: 'Pick a teammate, or leave the person blank for a company-wide day off.' };
  }
  return { value: { label, startDate: input.startDate, endDate, assigneeName } };
}

/** The calendar that applies to one assignee's tasks (or to company-wide days only for `null`). */
export function calendarFor(entries: readonly NonWorkDay[], assignee?: string | null): WorkCalendar {
  return { entries, assignee };
}

/** Entries sorted by start date, then end date, then label. */
export function sortNonWorkDays(entries: readonly NonWorkDay[]): NonWorkDay[] {
  return [...entries].sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate) || a.label.localeCompare(b.label),
  );
}

/** "Nov 26, 2026" or "Dec 24, 2026 – Jan 1, 2027". */
export function formatNonWorkRange(entry: Pick<NonWorkDay, 'startDate' | 'endDate'>): string {
  return entry.startDate === entry.endDate
    ? formatDateShort(entry.startDate)
    : `${formatDateShort(entry.startDate)} – ${formatDateShort(entry.endDate)}`;
}

export interface NonWorkSpan {
  id: string;
  label: string;
  scope: 'company' | 'pto';
  /** Day offset from the chart start (clamped to the chart) and length in days */
  offset: number;
  days: number;
}

/**
 * The stretches of a timeline row to shade: company-wide days always, per-person days only when
 * `assignee` matches. Entries outside `[chartStart, chartStart + totalDays)` are dropped and the rest clamped.
 */
export function buildNonWorkSpans(
  entries: readonly NonWorkDay[],
  assignee: string | null | undefined,
  chartStart: Date,
  totalDays: number,
): NonWorkSpan[] {
  const spans: NonWorkSpan[] = [];
  for (const e of entries) {
    if (e.assigneeName && e.assigneeName !== assignee) continue;
    const first = daysBetween(chartStart, new Date(e.startDate + 'T00:00:00'));
    const last = daysBetween(chartStart, new Date(e.endDate + 'T00:00:00'));
    if (last < 0 || first >= totalDays) continue;
    const offset = Math.max(first, 0);
    const end = Math.min(last, totalDays - 1);
    spans.push({
      id: e.id,
      label: e.label,
      scope: e.assigneeName ? 'pto' : 'company',
      offset,
      days: end - offset + 1,
    });
  }
  return spans;
}

/** One task's date changes from snapping it off newly added non-work days. */
export interface ScheduleSnap {
  task: Task;
  startDate?: string;
  due?: string;
}

/** What actually reached Linear for one snap: only the fields that saved, and whether any field failed. */
export interface SnapSaveResult {
  applied: ScheduleSnap;
  failed: boolean;
}

/**
 * Saves one snap, due date first. If the due date fails the start date is not attempted (a start
 * pulled past its due date must not land alone). If the due date saves and the start date fails,
 * `applied` keeps the due date so callers roll back only the start date and stay in sync with Linear.
 */
export async function saveScheduleSnap(
  snap: ScheduleSnap,
  saveDue: (due: string) => Promise<unknown>,
  saveStart: (startDate: string) => Promise<unknown>,
): Promise<SnapSaveResult> {
  const applied: ScheduleSnap = { task: snap.task };
  let failed = false;
  if (snap.due) {
    try {
      await saveDue(snap.due);
      applied.due = snap.due;
    } catch {
      return { applied, failed: true };
    }
  }
  if (snap.startDate) {
    try {
      await saveStart(snap.startDate);
      applied.startDate = snap.startDate;
    } catch {
      failed = true;
    }
  }
  return { applied, failed };
}

/**
 * Which tasks have to move because `added` just made their start or due date a non-work day.
 *
 * A start date moves forward to the next workday and a due date moves forward to the next workday
 * (both skipping weekends, holidays and that assignee's PTO in `entries`), so a due date never
 * moves earlier than planned. A start that would then land after its due date pulls the due date
 * along. Completed and cross-project (external) tasks are left alone, as are implicit due dates
 * (derived from the project's target date, so there is no Linear due date to change).
 */
export function planNonWorkDaySnap(
  tasks: readonly Task[],
  entries: readonly NonWorkDay[],
  added: NonWorkDay,
): ScheduleSnap[] {
  const snaps: ScheduleSnap[] = [];
  const toDate = (iso: string) => new Date(iso + 'T00:00:00');
  const forward = (iso: string, cal: WorkCalendar) => formatIsoDate(snapToWorkday(toDate(iso), 1, cal));

  for (const task of tasks) {
    if (task.isExternal || isTaskDone(task)) continue;
    const cal = calendarFor(entries, task.assignee);
    const startHit = task.startDate !== null && entryAppliesTo(added, task.startDate, task.assignee);
    const dueHit = !task.isDueImplicit && entryAppliesTo(added, task.due, task.assignee);
    if (!startHit && !dueHit) continue;

    let due = task.due;
    if (dueHit) due = forward(task.due, cal);
    let startDate = task.startDate;
    if (startHit && task.startDate) {
      const next = forward(task.startDate, cal);
      if (next <= due) {
        startDate = next;
      } else if (!task.isDueImplicit) {
        startDate = next;
        due = next;
      }
    }

    const snap: ScheduleSnap = { task };
    if (startDate !== task.startDate && startDate) snap.startDate = startDate;
    if (due !== task.due) snap.due = due;
    if (snap.startDate || snap.due) snaps.push(snap);
  }
  return snaps;
}
