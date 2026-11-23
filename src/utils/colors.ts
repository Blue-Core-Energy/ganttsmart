export const priorityColors: Record<string, string> = {
  Urgent: '#ef4444',
  High: '#f97316',
  Medium: '#f59e0b',
  Low: '#22c55e',
  None: '#a1a1aa',
};

export const statusDotColors: Record<string, string> = {
  started: '#7c5cfc',
  unstarted: '#52525b',
  completed: '#22c55e',
  canceled: '#a1a1aa',
  duplicate: '#a1a1aa',
  triage: '#f59e0b',
  backlog: '#52525b',
};

export const idColors: Record<string, string> = {
  urgent: '#ef4444',
  high: '#f97316',
  medium: '#f59e0b',
  low: '#22c55e',
  none: '#a1a1aa',
};

export const priorityBadgeClasses: Record<string, string> = {
  urgent: 'bg-urgent/15 text-urgent border border-urgent/25',
  high: 'bg-high/15 text-high border border-high/25',
  medium: 'bg-medium/15 text-medium border border-medium/25',
  low: 'bg-low/15 text-low border border-low/25',
  none: 'bg-none/15 text-none border border-none/25',
};

export function priorityClass(val: number): string {
  if (val === 1) return 'urgent';
  if (val === 2) return 'high';
  if (val === 3) return 'medium';
  if (val === 4) return 'low';
  return 'none';
}
