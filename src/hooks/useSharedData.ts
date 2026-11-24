import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Filters, Milestone, Task } from '@/types';
import { clampDayWidth, DEFAULT_DAY_WIDTH, deriveTimeScale, ZOOM_STEP, zoomDayWidth } from '@/utils/timelineZoom';
import { filterActiveTasks, isIgnoredTask } from '@/utils/issues';
import { filterTasks, isTaskDone, mergeUnifiedTasks } from '@/utils/tasks';

export interface FunctionInvokeErrorPayload {
  error?: string;
  requiresPassword?: boolean;
  needsPassword?: boolean;
  expired?: boolean;
  retryAfterSeconds?: number;
  projectName?: string;
  [key: string]: unknown;
}

export interface FunctionInvokeErrorResult {
  status?: number;
  message: string;
  payload?: FunctionInvokeErrorPayload | null;
}

export async function parseFunctionInvokeError(
  fnError: unknown,
  responseObj?: Response | null,
): Promise<FunctionInvokeErrorResult | null> {
  if (!fnError) return null;

  let status: number | undefined;
  let payload: FunctionInvokeErrorPayload | null = null;
  const message = (fnError as Error)?.message || 'Edge Function returned a non-2xx status code';

  const ctx = (fnError as { context?: unknown })?.context ?? responseObj;

  if (ctx && typeof ctx === 'object') {
    if ('status' in ctx && typeof ctx.status === 'number') {
      status = ctx.status;
    }

    if ('text' in ctx && typeof ctx.text === 'function') {
      try {
        let rawText = '';
        try {
          const responseToRead = 'clone' in ctx && typeof ctx.clone === 'function' ? ctx.clone() : ctx;
          rawText = await responseToRead.text();
        } catch {
          rawText = await (ctx as Response).text();
        }
        if (rawText) {
          try {
            const parsed = JSON.parse(rawText);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              payload = parsed as FunctionInvokeErrorPayload;
            } else {
              payload = { error: String(parsed) };
            }
          } catch {
            payload = { error: rawText };
          }
        }
      } catch {
        // Stream read failed
      }
    } else if (!(ctx instanceof Error)) {
      payload = ctx as FunctionInvokeErrorPayload;
      if (typeof payload.status === 'number' && !status) {
        status = payload.status;
      }
    }
  }

  return { status, message, payload };
}

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

      const handleInvokeError = (
        parsed: FunctionInvokeErrorResult | null,
        submittedPassword: string | undefined,
        fallbackMessage: string,
      ) => {
        const status = parsed?.status;
        const payload = parsed?.payload;
        const errorMsg =
          payload?.error ||
          (status === 403
            ? 'Incorrect password'
            : status === 429
              ? 'Too many attempts. Try again later.'
              : status === 410
                ? 'This shared link has expired.'
                : status === 404
                  ? 'Share not found'
                  : parsed?.message || fallbackMessage);

        if (payload?.projectName) {
          setProjectName(payload.projectName);
        }

        if (status === 403 || payload?.requiresPassword || payload?.needsPassword) {
          setNeedsPassword(true);
          setPasswordError(errorMsg);
          return;
        }

        if (status === 429) {
          setNeedsPassword(true);
          setPasswordError(errorMsg);
          return;
        }

        if (status === 400 && submittedPassword !== undefined) {
          setNeedsPassword(true);
          setPasswordError(errorMsg);
          return;
        }

        if (status === 410 || payload?.expired) {
          setNeedsPassword(false);
          setError('This shared link has expired.');
          return;
        }

        if (status === 404) {
          setNeedsPassword(false);
          setError(errorMsg || 'Share not found');
          return;
        }

        setNeedsPassword(false);
        setError(errorMsg);
      };

      try {
        const {
          data,
          error: fnError,
          response,
        } = await supabase.functions.invoke('share-roadmap', {
          body: { action: 'get', shareToken, password },
        });

        if (fnError) {
          const parsed = await parseFunctionInvokeError(fnError, response);
          handleInvokeError(parsed, password, 'Failed to load shared roadmap');
          return;
        }

        if (!data) {
          setNeedsPassword(false);
          setError('Failed to load shared roadmap');
          return;
        }

        if ((data.needsPassword || data.requiresPassword) && !data.cachedData) {
          setNeedsPassword(true);
          setProjectName(data.projectName || '');
          if (data.error) setPasswordError(data.error);
          return;
        }

        if (data.error) {
          setNeedsPassword(false);
          setError(data.error);
          return;
        }

        if (data.expired) {
          setNeedsPassword(false);
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
        const parsed = await parseFunctionInvokeError(e);
        handleInvokeError(parsed, password, (e as Error).message || 'Failed to load shared roadmap');
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
