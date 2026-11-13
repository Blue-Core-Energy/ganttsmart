import type { Filters, GroupBy, Task } from '@/types';

/** Whether a task is considered completed (statusType 'completed' or has completedAt, excluding canceled). */
export function isTaskDone(task: Pick<Task, 'statusType' | 'completedAt'>): boolean {
  return task.statusType !== 'canceled' && (task.statusType === 'completed' || Boolean(task.completedAt));
}

/** Default schedule sort: priority ascending, then due date ascending, then identifier. */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      a.priorityVal - b.priorityVal ||
      new Date(a.due).getTime() - new Date(b.due).getTime() ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Re-order tasks according to saved custom order (uuids).
 * Tasks not present in customOrder keep their relative order after ordered tasks.
 */
export function applyCustomOrder(tasks: Task[], customOrder: string[]): Task[] {
  if (customOrder.length === 0) return tasks;
  const pos = new Map(customOrder.map((uuid, i) => [uuid, i]));
  return [...tasks].sort((a, b) => {
    const ai = pos.get(a.uuid);
    const bi = pos.get(b.uuid);
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
}

/**
 * Merge a primary task list with any legacy `doneTasks` array (e.g. from older shared snapshots),
 * deduplicating by `uuid || id` and sorting into unified order when legacy items are present.
 */
export function mergeUnifiedTasks(tasks: Task[], doneTasks?: Task[]): Task[] {
  if (!doneTasks || doneTasks.length === 0) return tasks;
  const seen = new Set(tasks.map((t) => t.uuid || t.id));
  const merged = [...tasks];
  for (const t of doneTasks) {
    const key = t.uuid || t.id;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(t);
    }
  }
  return sortTasks(merged);
}

/** Filter tasks by priority, assignee, status, completed visibility, and search text. */
export function filterTasks(tasks: Task[], filters: Filters): Task[] {
  const searchLower = filters.search.trim().toLowerCase();
  return tasks.filter((t) => {
    if (!filters.showCompleted && isTaskDone(t)) return false;
    if (!filters.priorities.has(t.priorityVal)) return false;
    if (filters.assignee && t.assignee !== filters.assignee) return false;
    if (filters.status && t.status !== filters.status) return false;
    if (searchLower) {
      const hay = `${t.id} ${t.title} ${t.assignee} ${t.status}`.toLowerCase();
      if (!hay.includes(searchLower)) return false;
    }
    return true;
  });
}

/** Group tasks for the Gantt chart table. */
export function groupTasks(tasks: Task[], groupBy: GroupBy): { key: string; label: string; tasks: Task[] }[] {
  if (groupBy === 'none') return [{ key: '__all', label: '', tasks }];

  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    let key: string;
    if (groupBy === 'assignee') key = t.assignee;
    else if (groupBy === 'priority') key = t.priority;
    else key = t.status;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }

  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, grouped]) => ({ key, label: key, tasks: grouped }));
}

/**
 * Detect dependency violations: an active blocked task starting on or before an active blocker's due date.
 * Completed tasks and completed blockers are never flagged as schedule violations.
 */
export function computeDepViolations(tasks: Task[], today: Date): Map<string, string[]> {
  const violations = new Map<string, string[]>();
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  const addViolation = (blockedId: string, blockerId: string) => {
    if (!violations.has(blockedId)) violations.set(blockedId, []);
    const list = violations.get(blockedId)!;
    if (!list.includes(blockerId)) list.push(blockerId);
  };

  for (const task of tasks) {
    if (isTaskDone(task) || task.isUnscheduledExternal) continue;

    for (const blockerId of task.blockedBy) {
      const blocker = taskMap.get(blockerId);
      if (!blocker || isTaskDone(blocker) || blocker.isUnscheduledExternal) continue;
      const taskStart = task.startDate ? new Date(task.startDate + 'T00:00:00') : today;
      const blockerDue = new Date(blocker.due + 'T00:00:00');
      if (taskStart <= blockerDue) addViolation(task.id, blockerId);
    }

    for (const blockedId of task.blocks) {
      const blocked = taskMap.get(blockedId);
      if (!blocked || isTaskDone(blocked) || blocked.isUnscheduledExternal) continue;
      const blockedStart = blocked.startDate ? new Date(blocked.startDate + 'T00:00:00') : today;
      const blockerDue = new Date(task.due + 'T00:00:00');
      if (blockedStart <= blockerDue) addViolation(blockedId, task.id);
    }
  }

  return violations;
}

/** Compute summary KPI counts and date span across a task list. */
export function computeTaskStats(tasks: Task[]): {
  active: number;
  inProgress: number;
  completed: number;
  span: number;
} {
  let active = 0;
  let inProgress = 0;
  let completed = 0;
  const dates: number[] = [];

  for (const t of tasks) {
    const done = isTaskDone(t);
    if (done) {
      completed++;
    } else if (t.statusType !== 'canceled') {
      active++;
    }
    if (t.statusType === 'started') {
      inProgress++;
    }
    if (t.startDate) {
      const d = new Date(t.startDate + 'T00:00:00').getTime();
      if (!Number.isNaN(d)) dates.push(d);
    }
    if (t.due) {
      const d = new Date(t.due + 'T00:00:00').getTime();
      if (!Number.isNaN(d)) dates.push(d);
    }
  }

  const span = dates.length < 2 ? 0 : Math.max(0, Math.round((Math.max(...dates) - Math.min(...dates)) / 86400000));

  return { active, inProgress, completed, span };
}
