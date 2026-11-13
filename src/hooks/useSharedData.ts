import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { DEFAULT_DAY_WIDTH, MAX_DAY_WIDTH, MIN_DAY_WIDTH, TIME_SCALE_FACTORS } from '@/types';
import type { Filters, GroupBy, Milestone, Task, TimeScale } from '@/types';
import { filterActiveTasks, isIgnoredTask } from '@/utils/issues';
import { filterTasks, isTaskDone, mergeUnifiedTasks } from '@/utils/tasks';

const DEFAULT_PRIORITIES = new Set([0, 1, 2, 3, 4]);

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
  const [dayWidth, setDayWidth] = useState(DEFAULT_DAY_WIDTH);
  const [timeScale, setTimeScale] = useState<TimeScale>('day');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [filters, setFilters] = useState<Filters>({
    assignee: '',
    status: '',
    priorities: new Set(DEFAULT_PRIORITIES),
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

  const zoomIn = useCallback(() => {
    setDayWidth((w) => Math.min(w + 7, MAX_DAY_WIDTH));
  }, []);

  const zoomOut = useCallback(() => {
    setDayWidth((w) => Math.max(w - 7, MIN_DAY_WIDTH));
  }, []);

  // Effective px-per-day: week/month views compress the axis
  const effectiveDayWidth = dayWidth * TIME_SCALE_FACTORS[timeScale];

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
    effectiveDayWidth,
    timeScale,
    setTimeScale,
    groupBy,
    filters,
    setFilters,
    setGroupBy,
    zoomIn,
    zoomOut,
  };
}
