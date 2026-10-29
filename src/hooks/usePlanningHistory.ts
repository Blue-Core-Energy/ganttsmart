import { useCallback, useEffect, useRef, useState } from 'react';
import { backend, type ChangeEvent, type TaskBaseline } from '@/backend';
import type { Task } from '@/types';

export type { ChangeEvent, TaskBaseline };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Manages planning history: captures baselines on first load and logs change events.
 * Baselines are the first-seen dates for each task — the "original plan".
 * Change events are logged when due dates, start dates, or statuses are modified.
 */
export function usePlanningHistory(projectId: string) {
  const [baselines, setBaselines] = useState<Map<string, TaskBaseline>>(new Map());
  const baselinesSynced = useRef(false);
  const projectRef = useRef(projectId);

  // Reset when project changes
  useEffect(() => {
    if (projectRef.current !== projectId) {
      projectRef.current = projectId;
      baselinesSynced.current = false;
      setBaselines(new Map());
    }
  }, [projectId]);

  // Load existing baselines from DB
  const loadBaselines = useCallback(async () => {
    if (!projectId) return;

    let rows: TaskBaseline[];
    try {
      rows = await backend.history.loadBaselines(projectId);
    } catch (e) {
      console.warn('Failed to load baselines:', errorMessage(e));
      return;
    }

    const map = new Map<string, TaskBaseline>();
    for (const row of rows) {
      map.set(row.issue_id, row);
    }
    setBaselines(map);
    return map;
  }, [projectId]);

  // Sync baselines: for any task we haven't seen before, store its current dates as the baseline
  const syncBaselines = useCallback(
    async (tasks: Task[]) => {
      if (!projectId || baselinesSynced.current) return;
      baselinesSynced.current = true;

      // Load current baselines first
      let currentBaselines = baselines;
      if (currentBaselines.size === 0) {
        const loaded = await loadBaselines();
        if (loaded) currentBaselines = loaded;
      }

      // Find tasks that don't have baselines yet
      const newBaselines = tasks.filter((t) => !currentBaselines.has(t.id));
      if (newBaselines.length === 0) return;

      const rows = newBaselines.map((t) => ({
        issue_id: t.id,
        planned_start: t.startDate,
        planned_due: t.due,
      }));

      try {
        await backend.history.addBaselines(projectId, rows);
      } catch (e) {
        console.warn('Failed to save baselines:', errorMessage(e));
        return;
      }

      // Update local state
      const updated = new Map(currentBaselines);
      for (const t of newBaselines) {
        updated.set(t.id, {
          issue_id: t.id,
          planned_start: t.startDate,
          planned_due: t.due,
          first_seen_at: new Date().toISOString(),
        });
      }
      setBaselines(updated);
    },
    [projectId, baselines, loadBaselines],
  );

  // Log a field change to issue_change_history
  const logChange = useCallback(
    async (issueId: string, field: string, oldValue: string | null, newValue: string | null) => {
      if (!projectId) return;
      try {
        await backend.history.logChange(projectId, issueId, field, oldValue, newValue);
      } catch (e) {
        console.warn('Failed to log change:', errorMessage(e));
      }
    },
    [projectId],
  );

  // Log a status transition
  const logStatusTransition = useCallback(
    async (issueId: string, fromStatus: string | null, toStatus: string) => {
      if (!projectId) return;
      try {
        await backend.history.logStatusTransition(projectId, issueId, fromStatus, toStatus);
      } catch (e) {
        console.warn('Failed to log status transition:', errorMessage(e));
      }
    },
    [projectId],
  );

  // Fetch change history for a specific task
  const getTaskHistory = useCallback(
    async (issueId: string): Promise<ChangeEvent[]> => {
      if (!projectId) return [];
      try {
        return await backend.history.getTaskHistory(issueId);
      } catch (e) {
        console.warn('Failed to fetch task history:', errorMessage(e));
        return [];
      }
    },
    [projectId],
  );

  return {
    baselines,
    syncBaselines,
    logChange,
    logStatusTransition,
    getTaskHistory,
  };
}
