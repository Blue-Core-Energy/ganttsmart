import type { DayOff } from './types.js';

/** Start date, then end date, then label, then id (so the order is always deterministic). */
export function sortDaysOff(entries: DayOff[]): DayOff[] {
  return entries.sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      a.endDate.localeCompare(b.endDate) ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );
}
