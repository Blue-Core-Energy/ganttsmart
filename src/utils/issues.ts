import type { Task } from '@/types';

export interface IssueStateLike {
  name?: string | null;
  type?: string | null;
}

/**
 * Returns true when a Linear issue's workflow state or canceledAt timestamp
 * indicates it was canceled or marked as a duplicate and should be hidden
 * from GanttSmart schedules.
 */
export function isIgnoredIssueState(state?: IssueStateLike | null, canceledAt?: string | null): boolean {
  if (canceledAt) return true;
  const type = state?.type?.trim().toLowerCase();
  if (type === 'canceled' || type === 'cancelled' || type === 'duplicate') return true;
  const name = state?.name?.trim().toLowerCase();
  if (name === 'duplicate' || name === 'canceled' || name === 'cancelled') return true;
  return false;
}

export function isIgnoredTask(task: Pick<Task, 'status' | 'statusType'>): boolean {
  return isIgnoredIssueState({ name: task.status, type: task.statusType });
}

/**
 * Filters out canceled/duplicate tasks and strips references to ignored task IDs
 * from remaining tasks' `blocks` / `blockedBy` arrays.
 */
export function filterActiveTasks(tasks: Task[], extraIgnoredIds?: ReadonlySet<string>): Task[] {
  const ignoredIds = new Set<string>(extraIgnoredIds);
  const kept: Task[] = [];
  for (const t of tasks) {
    if (isIgnoredTask(t)) {
      ignoredIds.add(t.id);
    } else {
      kept.push(t);
    }
  }
  if (ignoredIds.size === 0) return kept;
  return kept.map((t) => {
    const blocks = t.blocks.filter((id) => !ignoredIds.has(id));
    const blockedBy = t.blockedBy.filter((id) => !ignoredIds.has(id));
    if (blocks.length === t.blocks.length && blockedBy.length === t.blockedBy.length) return t;
    return { ...t, blocks, blockedBy };
  });
}
