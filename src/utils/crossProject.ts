import type { Filters, Task } from '@/types';
import { applyCustomOrder, isTaskDone, sortTasks } from './tasks';

/**
 * Combine local project tasks with cross-project dependency ghost tasks in display order:
 * - Tasks (local or external) present in `customOrder` keep their saved relative order.
 * - Unpositioned local tasks are appended after positioned tasks (preserving `applyCustomOrder`).
 * - Unpositioned external tasks are placed inline next to their linked local task:
 *   directly above the first local task they block, or directly below the first local task
 *   that blocks them.
 */
export function mergeTasksWithExternalOrder(localTasks: Task[], externalTasks: Task[], customOrder: string[]): Task[] {
  if (externalTasks.length === 0) {
    return applyCustomOrder(localTasks, customOrder);
  }

  const orderPos = new Map(customOrder.map((uuid, i) => [uuid, i]));

  const positioned: Task[] = [];
  const unpositionedLocals: Task[] = [];
  const unpositionedExternals: Task[] = [];

  for (const t of localTasks) {
    if (orderPos.has(t.uuid)) positioned.push(t);
    else unpositionedLocals.push(t);
  }

  for (const ext of externalTasks) {
    if (orderPos.has(ext.uuid)) positioned.push(ext);
    else unpositionedExternals.push(ext);
  }

  positioned.sort((a, b) => orderPos.get(a.uuid)! - orderPos.get(b.uuid)!);

  const result: Task[] = [...positioned, ...unpositionedLocals];
  const sortedUnpositionedExt = sortTasks(unpositionedExternals);

  for (const ext of sortedUnpositionedExt) {
    const blocksLocalIdx = result.findIndex(
      (t) => !t.isExternal && (ext.blocks.includes(t.id) || t.blockedBy.includes(ext.id)),
    );
    if (blocksLocalIdx !== -1) {
      result.splice(blocksLocalIdx, 0, ext);
      continue;
    }

    const blockedByLocalIdx = result.findIndex(
      (t) => !t.isExternal && (ext.blockedBy.includes(t.id) || t.blocks.includes(ext.id)),
    );
    if (blockedByLocalIdx !== -1) {
      const anchor = result[blockedByLocalIdx];
      let insertIdx = blockedByLocalIdx + 1;
      while (
        insertIdx < result.length &&
        result[insertIdx].isExternal &&
        (result[insertIdx].blockedBy.includes(anchor.id) || anchor.blocks.includes(result[insertIdx].id))
      ) {
        insertIdx++;
      }
      result.splice(insertIdx, 0, ext);
      continue;
    }

    result.push(ext);
  }

  return result;
}

/**
 * Determine which external cross-project tasks should be displayed alongside `visibleLocalTasks`.
 * Preserves dependency context for visible local tasks while respecting `showExternal`,
 * `filters.showCompleted`, and direct search hits on external tasks.
 */
export function filterExternalTasks(
  externalTasks: Task[],
  visibleLocalTasks: Task[],
  filters: Filters,
  showExternal: boolean,
): Task[] {
  if (!showExternal || externalTasks.length === 0) return [];

  const visibleLocalIds = new Set(visibleLocalTasks.map((t) => t.id));
  const searchLower = filters.search.trim().toLowerCase();

  return externalTasks.filter((ext) => {
    if (!filters.showCompleted && isTaskDone(ext)) return false;

    const linkedToVisibleLocal =
      ext.blocks.some((id) => visibleLocalIds.has(id)) || ext.blockedBy.some((id) => visibleLocalIds.has(id));
    if (linkedToVisibleLocal) return true;

    if (searchLower) {
      const hay = `${ext.id} ${ext.title} ${ext.assignee} ${ext.status} ${ext.projectName || ''}`.toLowerCase();
      return hay.includes(searchLower);
    }

    return false;
  });
}

/**
 * Remove any external tasks that no longer have a blocks/blockedBy link to any local task.
 */
export function pruneUnlinkedExternalTasks(externalTasks: Task[], localTasks: Task[]): Task[] {
  if (externalTasks.length === 0) return externalTasks;
  const localIds = new Set(localTasks.map((t) => t.id));
  return externalTasks.filter(
    (ext) => ext.blocks.some((id) => localIds.has(id)) || ext.blockedBy.some((id) => localIds.has(id)),
  );
}
