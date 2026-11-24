export function localOffsetDate(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

export function isoOffsetDays(days: number): string {
  const d = localOffsetDate(days);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function startTagOffsetDays(days: number): string {
  const d = localOffsetDate(days);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `start: ${dd}-${mm}-${yy}`;
}

/** Monday of the coming week (or today when it is a Monday), as a day offset from today. */
export function mondayOffset(): number {
  return (8 - localOffsetDate(0).getDay()) % 7;
}
