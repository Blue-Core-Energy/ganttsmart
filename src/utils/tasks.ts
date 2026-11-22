import type { Filters, Task } from '@/types';

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

/** Filter tasks by assignee, status, completed visibility, and search text. */
export function filterTasks(tasks: Task[], filters: Filters): Task[] {
  const searchLower = filters.search.trim().toLowerCase();
  return tasks.filter((t) => {
    if (!filters.showCompleted && isTaskDone(t)) return false;
    if (filters.assignee && t.assignee !== filters.assignee) return false;
    if (filters.status && t.status !== filters.status) return false;
    if (searchLower) {
      const hay = `${t.id} ${t.title} ${t.assignee} ${t.status}`.toLowerCase();
      if (!hay.includes(searchLower)) return false;
    }
    return true;
  });
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

/** Whether search or an assignee/status filter is narrowing the rows (collapsed parents must not hide matches). */
export function hasActiveRowFilters(filters: Pick<Filters, 'search' | 'assignee' | 'status'>): boolean {
  return Boolean(filters.search.trim() || filters.assignee || filters.status);
}

export interface TaskHierarchy {
  /** All tasks grouped parent-first: each sub-issue sits directly under its parent, after earlier siblings' subtrees */
  tasks: Task[];
  /** Nesting depth by task id (0 = top level) */
  depthById: Map<string, number>;
  /** Parent task id, only for tasks whose parent is also in the list; anything else is a top-level row */
  parentById: Map<string, string>;
  /** Direct child ids by parent task id, in display order */
  childIdsById: Map<string, string[]>;
}

/**
 * Group sub-issues directly beneath their parent while keeping everything else in its incoming order.
 * A parent keeps its own position among top-level rows and its children keep their relative order, so this
 * composes with any sort or custom order. Sub-issues whose parent is not in the list stay top-level rows.
 */
export function buildTaskHierarchy(tasks: Task[]): TaskHierarchy {
  const ids = new Set(tasks.map((t) => t.id));
  const parentById = new Map<string, string>();
  for (const t of tasks) {
    if (t.parentId && t.parentId !== t.id && ids.has(t.parentId)) parentById.set(t.id, t.parentId);
  }

  const childIdsById = new Map<string, string[]>();
  for (const t of tasks) {
    const parent = parentById.get(t.id);
    if (!parent) continue;
    const siblings = childIdsById.get(parent);
    if (siblings) siblings.push(t.id);
    else childIdsById.set(parent, [t.id]);
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depthById = new Map<string, number>();
  const grouped: Task[] = [];

  const emit = (task: Task, depth: number) => {
    if (depthById.has(task.id)) return;
    depthById.set(task.id, depth);
    grouped.push(task);
    for (const childId of childIdsById.get(task.id) ?? []) emit(byId.get(childId)!, depth + 1);
  };

  for (const t of tasks) if (!parentById.has(t.id)) emit(t, 0);

  // Linear can't produce parent cycles, but a corrupt snapshot must not make rows vanish
  for (const t of tasks) {
    if (depthById.has(t.id)) continue;
    const parent = parentById.get(t.id);
    parentById.delete(t.id);
    const siblings = parent ? childIdsById.get(parent) : undefined;
    if (parent && siblings) {
      childIdsById.set(
        parent,
        siblings.filter((id) => id !== t.id),
      );
    }
    emit(t, 0);
  }

  return { tasks: parentById.size === 0 ? tasks : grouped, depthById, parentById, childIdsById };
}

/** Group sub-issues under their parents. See {@link buildTaskHierarchy}. */
export function groupSubtasksUnderParents(tasks: Task[]): Task[] {
  return buildTaskHierarchy(tasks).tasks;
}

export interface VisibleHierarchy {
  /** Rows to render: the grouped tasks minus everything under a collapsed parent */
  rows: Task[];
  /** Hidden task id → id of the outermost collapsed ancestor whose row stands in for it */
  hiddenInto: Map<string, string>;
}

/** Hide the descendants of every collapsed parent. Collapsed ids that are not parents here are ignored. */
export function applyCollapsedParents(hierarchy: TaskHierarchy, collapsed: ReadonlySet<string>): VisibleHierarchy {
  const hiddenInto = new Map<string, string>();
  if (collapsed.size === 0) return { rows: hierarchy.tasks, hiddenInto };

  const rows: Task[] = [];
  for (const task of hierarchy.tasks) {
    const parent = hierarchy.parentById.get(task.id);
    if (parent) {
      const standIn = hiddenInto.get(parent) ?? (collapsed.has(parent) ? parent : undefined);
      if (standIn) {
        hiddenInto.set(task.id, standIn);
        continue;
      }
    }
    rows.push(task);
  }
  return { rows, hiddenInto };
}

/**
 * Compute the full custom order (uuids) after dragging `draggedUuid` next to `targetUuid`, keeping the
 * hierarchy intact: a parent moves together with its sub-issues, and a sub-issue can only move among its
 * siblings. Dropping on a row nested inside a sibling resolves to that sibling. Returns null when the move
 * would cross a parent boundary (or is a no-op).
 *
 * `tasks` may include rows that are filtered out of view. Pass `visibleUuids` (the rows actually shown) so a
 * sub-issue whose parent is hidden counts as a top-level row, matching what the chart renders. Omit it to
 * treat every task as visible.
 */
export function reorderWithinHierarchy(
  tasks: Task[],
  draggedUuid: string,
  targetUuid: string,
  placeAfter: boolean,
  visibleUuids?: ReadonlySet<string>,
): string[] | null {
  if (draggedUuid === targetUuid) return null;
  const hierarchy = buildTaskHierarchy(tasks);
  const byUuid = new Map(hierarchy.tasks.map((t) => [t.uuid, t]));
  const byId = new Map(hierarchy.tasks.map((t) => [t.id, t]));
  const dragged = byUuid.get(draggedUuid);
  const target = byUuid.get(targetUuid);
  if (!dragged || !target) return null;

  // The parent as the user sees it: a hidden parent leaves its sub-issues at the top level
  const shownParent = (t: Task): string | undefined => {
    const parent = hierarchy.parentById.get(t.id);
    if (!parent || !visibleUuids) return parent;
    const parentTask = byId.get(parent);
    return parentTask && visibleUuids.has(parentTask.uuid) ? parent : undefined;
  };

  const draggedParent = shownParent(dragged);
  let anchor: Task | undefined = target;
  while (anchor && shownParent(anchor) !== draggedParent) {
    const up: string | undefined = shownParent(anchor);
    anchor = up ? byId.get(up) : undefined;
  }
  if (!anchor || anchor.id === dragged.id) return null;

  const isDescendantOf = (t: Task, ancestorId: string) => {
    for (let up = hierarchy.parentById.get(t.id); up; up = hierarchy.parentById.get(up)) {
      if (up === ancestorId) return true;
    }
    return false;
  };
  // A task's subtree is contiguous right after it, hidden descendants included
  const blockLength = (list: Task[], start: number) => {
    let len = 1;
    while (start + len < list.length && isDescendantOf(list[start + len], list[start].id)) len++;
    return len;
  };

  const list = hierarchy.tasks;
  const from = list.indexOf(dragged);
  const block = list.slice(from, from + blockLength(list, from));
  const rest = [...list.slice(0, from), ...list.slice(from + block.length)];
  const anchorIdx = rest.indexOf(anchor);
  const insertAt = placeAfter ? anchorIdx + blockLength(rest, anchorIdx) : anchorIdx;
  rest.splice(insertAt, 0, ...block);
  return rest.map((t) => t.uuid);
}
