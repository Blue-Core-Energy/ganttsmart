import type { Task } from '@/types';
import { daysBetween } from '@/utils/date';
import { isTaskDone } from '@/utils/tasks';

/** Legend states in the order the legend lists them. */
export const SCHEDULE_STATES = ['done', 'overdue', 'in-progress', 'late-start', 'not-started'] as const;

/**
 * How an issue is tracking against its schedule. This is what a Gantt bar's colour means:
 * one state per bar, picked by the precedence in `scheduleState`.
 */
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

/** Bar / swatch class for a state. The colours themselves live in `src/index.css`. */
export function scheduleStateClass(state: ScheduleState): string {
  return `bar-${state}`;
}

/** Legend wording for each state. */
export const SCHEDULE_STATE_LABELS: Record<ScheduleState, string> = {
  done: 'Done',
  overdue: 'Overdue',
  'in-progress': 'In progress',
  'late-start': 'Late to start',
  'not-started': 'Not started',
};

/**
 * Which schedule state an issue is in, first match wins:
 *
 * 1. `done` — completed, even if it finished late
 * 2. `overdue` — past its due date, whether or not anyone is working on it, so red always means late
 * 3. `in-progress` — Linear state type `started`
 * 4. `late-start` — has a real start date that has passed but has not been started
 * 5. `not-started` — everything else
 *
 * An issue with no start date is never `late-start`: without one there is no evidence it is late
 * to begin. Dates are compared as calendar days in the viewer's timezone.
 */
export function scheduleState(
  task: Pick<Task, 'statusType' | 'completedAt' | 'due' | 'startDate'>,
  today: Date,
): ScheduleState {
  if (isTaskDone(task)) return 'done';
  // A task with an empty or missing due date cannot be overdue
  if (task.due && daysBetween(today, new Date(task.due + 'T00:00:00')) < 0) return 'overdue';
  if (task.statusType === 'started') return 'in-progress';
  if (task.startDate && daysBetween(today, new Date(task.startDate + 'T00:00:00')) < 0) return 'late-start';
  return 'not-started';
}
