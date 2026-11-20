import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Filters, Milestone, Task } from '@/types';
import { clampDayWidth, DEFAULT_DAY_WIDTH, deriveTimeScale, ZOOM_STEP, zoomDayWidth } from '@/utils/timelineZoom';
import { filterActiveTasks, isIgnoredTask } from '@/utils/issues';
import { filterTasks, isTaskDone, mergeUnifiedTasks } from '@/utils/tasks';

export function useSharedData(shareToken: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [unscheduledTasks, setUnscheduledTasks] = useState<Task[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [projectName, setProjectName] = useState('');
  const [cachedAt, setCachedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [dayWidth, setDayWidthState] = useState(DEFAULT_DAY_WIDTH);
  const [filters, setFilters] = useState<Filters>({
    assignee: '',
    status: '',
    search: '',
    dateFrom: '',
    dateTo: '',
    showCompleted: true,
  });

  const assignees = useMemo(() => [...new Set(tasks.map((t) => t.assignee))].sort(), [tasks]);
  const statuses = useMemo(
    () => [...new Set(tasks.filter((t) => filters.showCompleted || !isTaskDone(t)).map((t) => t.status))].sort(),
    [tasks, filters.showCompleted],
  );

  const filteredTasks = useMemo(() => filterTasks(tasks, filters), [tasks, filters]);

  const fetchSharedData = useCallback(
    async (password?: string) => {
      setLoading(true);
      setError('');
      setPasswordError('');

      try {
        const { data, error: fnError } = await supabase.functions.invoke('share-roadmap', {
          body: { action: 'get', shareToken, password },
        });

        if (fnError) throw new Error(fnError.message);

        if (data.needsPassword && !data.cachedData) {
          setNeedsPassword(true);
          setProjectName(data.projectName || '');
          if (data.error) setPasswordError(data.error);
          return;
        }

        if (data.error) {
          setError(data.error);
          return;
        }

        if (data.expired) {
          setError('This shared link has expired.');
          return;
        }

        const rawTasks: Task[] = data.cachedData?.tasks || [];
        const rawDone: Task[] = data.cachedData?.doneTasks || [];
        const rawUnscheduled: Task[] = data.cachedData?.unscheduledTasks || [];
        const ignoredIds = new Set<string>(
          [...rawTasks, ...rawDone, ...rawUnscheduled].filter(isIgnoredTask).map((t) => t.id),
        );

        setNeedsPassword(false);
        setProjectName(data.projectName);
        setTasks(mergeUnifiedTasks(filterActiveTasks(rawTasks, ignoredIds), filterActiveTasks(rawDone, ignoredIds)));
        setUnscheduledTasks(filterActiveTasks(rawUnscheduled, ignoredIds));
        setMilestones(data.cachedData?.milestones || []);
        setCachedAt(data.cachedAt);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [shareToken],
  );

  const submitPassword = useCallback(
    (password: string) => {
      fetchSharedData(password);
    },
    [fetchSharedData],
  );

  /** Zoom is a single continuous px-per-day value; the header granularity follows it */
  const setDayWidth = useCallback((next: number | ((current: number) => number)) => {
    setDayWidthState((current) => clampDayWidth(typeof next === 'function' ? next(current) : next));
  }, []);

  const zoomIn = useCallback(() => setDayWidth((w) => zoomDayWidth(w, ZOOM_STEP)), [setDayWidth]);
  const zoomOut = useCallback(() => setDayWidth((w) => zoomDayWidth(w, 1 / ZOOM_STEP)), [setDayWidth]);

  const timeScale = useMemo(() => deriveTimeScale(dayWidth), [dayWidth]);

  useEffect(() => {
    if (shareToken) fetchSharedData();
  }, [shareToken, fetchSharedData]);

  return {
    tasks,
    unscheduledTasks,
    filteredTasks,
    milestones,
    projectName,
    cachedAt,
    assignees,
    statuses,
    loading,
    error,
    needsPassword,
    passwordError,
    submitPassword,
    dayWidth,
    setDayWidth,
    timeScale,
    filters,
    setFilters,
    zoomIn,
    zoomOut,
  };
}
