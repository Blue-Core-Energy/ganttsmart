import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DebounceCancelled,
  type ProjectExternalLink,
  createIssueRelation,
  createProjectExternalLink,
  fetchIssues,
  fetchProjectExternalLinks,
  fetchProjects,
  fetchWorkflowStates,
  findActiveExternalLink,
  removeIssueRelation,
  updateIssueDueDate,
  updateIssueStartDate,
  updateIssueState,
  updateMilestoneTargetDate,
} from '@/api/linear';
import { toast, toastError, toastSuccess } from '@/components/toastStore';
import { DEFAULT_DAY_WIDTH, MAX_DAY_WIDTH, MIN_DAY_WIDTH, TIME_SCALE_FACTORS } from '@/types';
import type { Filters, GroupBy, Milestone, Project, Task, TimeScale, WorkflowState } from '@/types';
import { buildProjectDeepLink, resolveProjectId } from '@/utils/projectDeepLink';
import { applyCustomOrder, filterTasks, isTaskDone } from '@/utils/tasks';
import { applyWorkflowStateToTask, findWorkflowStateForTask, getNextWorkflowState } from '@/utils/workflowStates';

const DEFAULT_PRIORITIES = new Set([0, 1, 2, 3, 4]);
const POLL_INTERVAL_MS = 30_000; // 30 seconds

const customOrderKey = (projectId: string) => `linear_custom_order_${projectId}`;

/** Read the persisted custom display order for a project (task uuids). Exported for ShareDialog. */
export function loadCustomOrder(projectId: string): string[] {
  if (!projectId) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(customOrderKey(projectId)) || '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function useLinearData(linearToken: string, onAuthError?: () => void, requestedProjectId?: string | null) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [linearProjectUrl, setLinearProjectUrl] = useState<string | null>(null);
  const [projectExternalLinks, setProjectExternalLinks] = useState<ProjectExternalLink[]>([]);
  const [linkingToLinear, setLinkingToLinear] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [unscheduledTasks, setUnscheduledTasks] = useState<Task[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [workflowStatesByTeam, setWorkflowStatesByTeam] = useState<Record<string, WorkflowState[]>>({});
  const workflowStates = useMemo(() => Object.values(workflowStatesByTeam).flat(), [workflowStatesByTeam]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastSynced, setLastSynced] = useState('');
  const [dayWidth, setDayWidth] = useState(DEFAULT_DAY_WIDTH);
  const [timeScale, setTimeScaleState] = useState<TimeScale>(() => {
    const s = localStorage.getItem('gantt_time_scale');
    return s === 'week' || s === 'month' ? s : 'day';
  });
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

  const initialLoadDone = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingMutations = useRef(0); // guards polling from overwriting optimistic state
  const activeProjectIdRef = useRef('');

  // Undo stack: stores previous task snapshots
  const undoStackRef = useRef<Array<{ tasks: Task[]; label: string }>>([]);

  const assignees = useMemo(() => [...new Set(tasks.map((t) => t.assignee))].sort(), [tasks]);
  const statuses = useMemo(
    () => [...new Set(tasks.filter((t) => filters.showCompleted || !isTaskDone(t)).map((t) => t.status))].sort(),
    [tasks, filters.showCompleted],
  );

  // Custom display order (uuids), persisted per project. Empty = default sort from the API.
  const [customOrder, setCustomOrder] = useState<string[]>(() => loadCustomOrder(selectedProjectId));

  useEffect(() => {
    setCustomOrder(loadCustomOrder(selectedProjectId));
  }, [selectedProjectId]);

  // Tasks in display order: saved positions first, unknown (new) tasks keep their
  // default priority/due order after them. Sort is stable, so ties preserve fetch order.
  const orderedTasks = useMemo(() => applyCustomOrder(tasks, customOrder), [tasks, customOrder]);

  const filteredTasks = useMemo(() => filterTasks(orderedTasks, filters), [orderedTasks, filters]);

  // Move a task next to another in the display order and persist it.
  const reorderTask = useCallback(
    (draggedUuid: string, targetUuid: string, placeAfter: boolean) => {
      if (draggedUuid === targetUuid) return;
      const order = orderedTasks.map((t) => t.uuid);
      const from = order.indexOf(draggedUuid);
      if (from === -1) return;
      order.splice(from, 1);
      const targetIdx = order.indexOf(targetUuid);
      if (targetIdx === -1) return;
      order.splice(placeAfter ? targetIdx + 1 : targetIdx, 0, draggedUuid);
      setCustomOrder(order);
      if (selectedProjectId) {
        try {
          localStorage.setItem(customOrderKey(selectedProjectId), JSON.stringify(order));
        } catch {
          // localStorage full/unavailable — order still applies for this session
        }
      }
    },
    [orderedTasks, selectedProjectId],
  );

  // Push to undo stack and show toast with Undo action
  const pushUndo = useCallback((prevTasks: Task[], label: string) => {
    undoStackRef.current.push({ tasks: prevTasks, label });
    // Keep max 20 undo entries
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
  }, []);

  const undo = useCallback(() => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    setTasks(entry.tasks);
    toastSuccess(`Undone: ${entry.label}`);
  }, []);

  const loadProjects = useCallback(async () => {
    if (!linearToken) return;
    try {
      const p = await fetchProjects(linearToken);
      setProjects(p);
      return p;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('authentication expired')) {
        toastError('Linear session expired. Reconnecting...');
        onAuthError?.();
        return [];
      }
      toastError(`Failed to load projects: ${msg}`);
      throw e;
    }
  }, [linearToken, onAuthError]);

  // Silent refresh for polling (no loading spinner, no error clearing)
  // Skips if there are pending mutations to avoid overwriting optimistic state
  const silentRefresh = useCallback(
    async (projectId: string) => {
      if (!linearToken || !projectId) return;
      if (pendingMutations.current > 0) return; // don't clobber optimistic state
      try {
        const result = await fetchIssues(linearToken, projectId);
        setTasks(result.tasks);
        setUnscheduledTasks(result.unscheduledTasks);
        setProjectName(result.projectName);
        setMilestones(result.milestones);
        setLastSynced(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
      } catch (e) {
        // Auto-disconnect on auth expiry, otherwise silent
        if ((e as Error).message?.includes('authentication expired')) {
          onAuthError?.();
        }
      }
    },
    [linearToken, onAuthError],
  );

  const loadIssues = useCallback(
    async (projectId: string) => {
      if (!linearToken || !projectId) return;
      setLoading(true);
      setError('');
      try {
        const result = await fetchIssues(linearToken, projectId);
        setTasks(result.tasks);
        setUnscheduledTasks(result.unscheduledTasks);
        setProjectName(result.projectName);
        setMilestones(result.milestones);
        setLastSynced(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
        const teamIds = [
          ...new Set([...result.tasks, ...result.unscheduledTasks].map((t) => t.teamId).filter(Boolean)),
        ];
        if (teamIds.length > 0) {
          const settled = await Promise.allSettled(
            teamIds.map(async (tid) => [tid, await fetchWorkflowStates(linearToken, tid)] as const),
          );
          if (!activeProjectIdRef.current || activeProjectIdRef.current === projectId) {
            const nextByTeam: Record<string, WorkflowState[]> = {};
            for (const item of settled) {
              if (item.status === 'fulfilled') {
                const [tid, states] = item.value;
                nextByTeam[tid] = states;
              }
            }
            if (Object.keys(nextByTeam).length > 0) {
              setWorkflowStatesByTeam((prev) => ({ ...prev, ...nextByTeam }));
            }
          }
        }
      } catch (e) {
        const msg = (e as Error).message;
        setError(msg);
        setTasks([]);
        setUnscheduledTasks([]);
        setMilestones([]);
        if (msg.includes('authentication expired')) {
          toastError('Linear session expired. Reconnecting...');
          onAuthError?.();
          return;
        }
        toastError(`Failed to load issues: ${msg}`, () => loadIssues(projectId));
      } finally {
        setLoading(false);
      }
    },
    [linearToken, onAuthError],
  );

  const loadProjectLinks = useCallback(
    async (projectId: string) => {
      if (!linearToken || !projectId) return;
      try {
        const meta = await fetchProjectExternalLinks(linearToken, projectId);
        if (activeProjectIdRef.current !== projectId) return;
        setLinearProjectUrl(meta.url);
        setProjectExternalLinks(meta.externalLinks);
      } catch (e) {
        if (activeProjectIdRef.current !== projectId) return;
        console.warn('Failed to fetch Linear project external links:', (e as Error).message);
        setLinearProjectUrl(null);
        setProjectExternalLinks([]);
      }
    },
    [linearToken],
  );

  const selectProject = useCallback(
    (id: string) => {
      activeProjectIdRef.current = id;
      setSelectedProjectId(id);
      setLinearProjectUrl(null);
      setProjectExternalLinks([]);
      localStorage.setItem('linear_selected_project', id);
      setFilters({
        assignee: '',
        status: '',
        priorities: new Set(DEFAULT_PRIORITIES),
        search: '',
        dateFrom: '',
        dateTo: '',
        showCompleted: true,
      });
      undoStackRef.current = []; // Clear undo on project switch
      void loadProjectLinks(id);
      loadIssues(id);
    },
    [loadIssues, loadProjectLinks],
  );

  const refresh = useCallback(() => {
    if (selectedProjectId) {
      void loadProjectLinks(selectedProjectId);
      loadIssues(selectedProjectId);
    }
  }, [selectedProjectId, loadIssues, loadProjectLinks]);

  const zoomIn = useCallback(() => {
    setDayWidth((w) => Math.min(w + 7, MAX_DAY_WIDTH));
  }, []);

  const zoomOut = useCallback(() => {
    setDayWidth((w) => Math.max(w - 7, MIN_DAY_WIDTH));
  }, []);

  const setTimeScale = useCallback((scale: TimeScale) => {
    setTimeScaleState(scale);
    try {
      localStorage.setItem('gantt_time_scale', scale);
    } catch {
      // localStorage unavailable — scale still applies for this session
    }
  }, []);

  // Effective px-per-day: week/month views compress the axis
  const effectiveDayWidth = dayWidth * TIME_SCALE_FACTORS[timeScale];

  // Optimistic reschedule (due date) with rollback + undo.
  // Also handles "promoting" an unscheduled task: if the uuid lives in unscheduledTasks,
  // we move it into tasks with the new explicit due date.
  const reschedule = useCallback(
    async (taskUuid: string, newDueDate: string) => {
      if (!linearToken) return;

      const prevTasks = tasks;
      const prevUnscheduled = unscheduledTasks;
      const fromUnscheduled = unscheduledTasks.find((t) => t.uuid === taskUuid);
      const task = tasks.find((t) => t.uuid === taskUuid) || fromUnscheduled;

      if (fromUnscheduled) {
        // Promote: remove from unscheduled, add to scheduled with explicit due date
        setUnscheduledTasks((prev) => prev.filter((t) => t.uuid !== taskUuid));
        setTasks((prev) => [...prev, { ...fromUnscheduled, due: newDueDate, isDueImplicit: undefined }]);
      } else {
        setTasks((prev) =>
          prev.map((t) => (t.uuid === taskUuid ? { ...t, due: newDueDate, isDueImplicit: undefined } : t)),
        );
      }

      pendingMutations.current++;
      try {
        await updateIssueDueDate(linearToken, taskUuid, newDueDate);
        pushUndo(prevTasks, `${task?.id || ''} due date`);
        toast(`Due date updated`, 'success', {
          label: 'Undo',
          onClick: () => {
            setTasks(prevTasks);
            setUnscheduledTasks(prevUnscheduled);
            if (task && task.due && !task.isDueImplicit) {
              updateIssueDueDate(linearToken, taskUuid, task.due).catch(() => {});
            }
          },
        });
      } catch (e) {
        if (e instanceof DebounceCancelled) return; // superseded by a newer drag — don't rollback
        setTasks(prevTasks);
        setUnscheduledTasks(prevUnscheduled);
        toastError(`Failed to update due date: ${(e as Error).message}`, () => reschedule(taskUuid, newDueDate));
      } finally {
        pendingMutations.current--;
      }
    },
    [linearToken, tasks, unscheduledTasks, pushUndo],
  );

  // Optimistic reschedule (start date) with rollback + undo
  const rescheduleStart = useCallback(
    async (taskUuid: string, newStartDate: string) => {
      if (!linearToken) return;

      const prevTasks = tasks;
      const task = tasks.find((t) => t.uuid === taskUuid);
      setTasks((prev) => prev.map((t) => (t.uuid === taskUuid ? { ...t, startDate: newStartDate } : t)));

      pendingMutations.current++;
      try {
        await updateIssueStartDate(linearToken, taskUuid, newStartDate);
        pushUndo(prevTasks, `${task?.id || ''} start date`);
        toast(`Start date updated`, 'success', {
          label: 'Undo',
          onClick: () => {
            setTasks(prevTasks);
            if (task?.startDate) updateIssueStartDate(linearToken, taskUuid, task.startDate).catch(() => {});
          },
        });
      } catch (e) {
        if (e instanceof DebounceCancelled) return; // superseded by a newer drag
        setTasks(prevTasks);
        toastError(`Failed to update start date: ${(e as Error).message}`, () =>
          rescheduleStart(taskUuid, newStartDate),
        );
      } finally {
        pendingMutations.current--;
      }
    },
    [linearToken, tasks, pushUndo],
  );

  // Optimistic milestone move (drag on the chart) with rollback + undo
  const updateMilestoneDate = useCallback(
    async (milestoneId: string, newTargetDate: string) => {
      if (!linearToken) return;

      const prevMilestones = milestones;
      const milestone = milestones.find((m) => m.id === milestoneId);
      if (!milestone) return;

      setMilestones((prev) => prev.map((m) => (m.id === milestoneId ? { ...m, targetDate: newTargetDate } : m)));

      pendingMutations.current++;
      try {
        await updateMilestoneTargetDate(linearToken, milestoneId, newTargetDate);
        toast(`${milestone.name} moved`, 'success', {
          label: 'Undo',
          onClick: () => {
            setMilestones(prevMilestones);
            if (milestone.targetDate) {
              updateMilestoneTargetDate(linearToken, milestoneId, milestone.targetDate).catch(() => {});
            }
          },
        });
      } catch (e) {
        if (e instanceof DebounceCancelled) return; // superseded by a newer drag
        setMilestones(prevMilestones);
        toastError(`Failed to move milestone: ${(e as Error).message}`, () =>
          updateMilestoneDate(milestoneId, newTargetDate),
        );
      } finally {
        pendingMutations.current--;
      }
    },
    [linearToken, milestones],
  );

  // Optimistic status cycle with rollback + undo
  const cycleStatus = useCallback(
    async (taskUuid: string): Promise<string | null> => {
      if (!linearToken) return null;
      const task = tasks.find((t) => t.uuid === taskUuid);
      if (!task) return null;

      let teamStates = task.teamId ? workflowStatesByTeam[task.teamId] : undefined;
      if ((!teamStates || teamStates.length === 0) && task.teamId) {
        try {
          const fetched = await fetchWorkflowStates(linearToken, task.teamId);
          teamStates = fetched;
          setWorkflowStatesByTeam((prev) => ({ ...prev, [task.teamId]: fetched }));
        } catch (e) {
          toastError(`Failed to load workflow states: ${(e as Error).message}`);
          return null;
        }
      }
      if (!teamStates || teamStates.length === 0) {
        teamStates = workflowStates;
      }
      if (teamStates.length === 0) {
        toastError('No workflow states available for this task');
        return null;
      }

      const nextState = getNextWorkflowState(task, teamStates);
      if (!nextState) return null;

      const prevTasks = tasks;
      const prevSnapshot = {
        status: task.status,
        statusType: task.statusType,
        completedAt: task.completedAt,
      };
      const prevState = findWorkflowStateForTask(task, teamStates);
      const completedAtIso = new Date().toISOString();

      setTasks((prev) =>
        prev.map((t) => (t.uuid === taskUuid ? applyWorkflowStateToTask(t, nextState, completedAtIso) : t)),
      );

      pendingMutations.current++;
      try {
        await updateIssueState(linearToken, taskUuid, nextState.id);
        pushUndo(prevTasks, `${task.id} status`);
        toast(`Status → ${nextState.name}`, 'success', {
          label: 'Undo',
          onClick: () => {
            setTasks((prev) => prev.map((t) => (t.uuid === taskUuid ? { ...t, ...prevSnapshot } : t)));
            if (prevState) updateIssueState(linearToken, taskUuid, prevState.id).catch(() => {});
          },
        });
        return nextState.name;
      } catch (e) {
        setTasks((prev) => prev.map((t) => (t.uuid === taskUuid ? { ...t, ...prevSnapshot } : t)));
        toastError(`Failed to update status: ${(e as Error).message}`, () => {
          void cycleStatus(taskUuid);
        });
        return null;
      } finally {
        pendingMutations.current--;
      }
    },
    [linearToken, workflowStatesByTeam, workflowStates, tasks, pushUndo],
  );

  // Create a "blocks" relation between two tasks
  const createRelation = useCallback(
    async (sourceTaskId: string, targetTaskId: string) => {
      if (!linearToken) return;

      const sourceTask = tasks.find((t) => t.id === sourceTaskId);
      const targetTask = tasks.find((t) => t.id === targetTaskId);
      if (!sourceTask || !targetTask) return;

      // Prevent duplicate
      if (sourceTask.blocks.includes(targetTaskId)) {
        toast(`${sourceTaskId} already blocks ${targetTaskId}`, 'info');
        return;
      }

      // Prevent circular
      if (targetTask.blocks.includes(sourceTaskId)) {
        toastError(`Cannot create circular dependency: ${targetTaskId} already blocks ${sourceTaskId}`);
        return;
      }

      const prevTasks = tasks;
      // Optimistic update
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id === sourceTaskId) return { ...t, blocks: [...t.blocks, targetTaskId] };
          if (t.id === targetTaskId) return { ...t, blockedBy: [...t.blockedBy, sourceTaskId] };
          return t;
        }),
      );

      pendingMutations.current++;
      try {
        await createIssueRelation(linearToken, sourceTask.uuid, targetTask.uuid);
        pushUndo(prevTasks, `${sourceTaskId} blocks ${targetTaskId}`);
        toastSuccess(`${sourceTaskId} now blocks ${targetTaskId}`);
      } catch (e) {
        setTasks(prevTasks);
        toastError(`Failed to create relation: ${(e as Error).message}`);
      } finally {
        pendingMutations.current--;
      }
    },
    [linearToken, tasks, pushUndo],
  );

  // Remove a "blocks" relation between two tasks
  // sourceTaskId = blocker identifier, targetTaskId = blocked identifier
  const removeRelation = useCallback(
    async (sourceTaskId: string, targetTaskId: string) => {
      if (!linearToken) return;

      const sourceTask = tasks.find((t) => t.id === sourceTaskId);
      const targetTask = tasks.find((t) => t.id === targetTaskId);
      if (!sourceTask || !targetTask) return;

      const prevTasks = tasks;
      // Optimistic update
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id === sourceTaskId) return { ...t, blocks: t.blocks.filter((id) => id !== targetTaskId) };
          if (t.id === targetTaskId) return { ...t, blockedBy: t.blockedBy.filter((id) => id !== sourceTaskId) };
          return t;
        }),
      );

      pendingMutations.current++;
      try {
        await removeIssueRelation(linearToken, sourceTask.uuid, targetTask.uuid);
        pushUndo(prevTasks, `${sourceTaskId} no longer blocks ${targetTaskId}`);
        toastSuccess(`Removed: ${sourceTaskId} → ${targetTaskId}`);
      } catch (e) {
        setTasks(prevTasks);
        toastError(`Failed to remove relation: ${(e as Error).message}`);
      } finally {
        pendingMutations.current--;
      }
    },
    [linearToken, tasks, pushUndo],
  );

  // Initial load when token is available
  useEffect(() => {
    if (!linearToken || initialLoadDone.current) return;
    initialLoadDone.current = true;

    (async () => {
      try {
        const p = await loadProjects();
        if (!p?.length) return;
        const saved = localStorage.getItem('linear_selected_project');
        const target = resolveProjectId(p, requestedProjectId, saved);
        activeProjectIdRef.current = target;
        setSelectedProjectId(target);
        localStorage.setItem('linear_selected_project', target);
        void loadProjectLinks(target);
        await loadIssues(target);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [linearToken, requestedProjectId, loadProjects, loadIssues, loadProjectLinks]);

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  const isLinkedInLinear = useMemo(() => {
    if (!selectedProjectId || !currentOrigin) return false;
    const targetUrl = buildProjectDeepLink(currentOrigin, selectedProjectId);
    return Boolean(findActiveExternalLink(projectExternalLinks, targetUrl));
  }, [selectedProjectId, currentOrigin, projectExternalLinks]);

  const addProjectLinkToLinear = useCallback(async () => {
    if (!linearToken || !selectedProjectId || !currentOrigin) return;
    const projectId = selectedProjectId;
    setLinkingToLinear(true);
    try {
      const result = await createProjectExternalLink(linearToken, projectId, currentOrigin);
      if (activeProjectIdRef.current !== projectId) return;
      setProjectExternalLinks((prev) =>
        findActiveExternalLink(prev, result.link.url) ? prev : [...prev, result.link],
      );
      if (result.projectUrl) setLinearProjectUrl(result.projectUrl);
      if (result.created) {
        toastSuccess('Added "Open in GanttSmart" link to Linear project');
      } else {
        toast('Project is already linked in Linear', 'info');
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('authentication expired')) {
        toastError('Linear session expired. Reconnecting...');
        onAuthError?.();
        return;
      }
      toastError(`Failed to add link to Linear: ${msg}`);
    } finally {
      setLinkingToLinear(false);
    }
  }, [linearToken, selectedProjectId, currentOrigin, onAuthError]);

  // Polling: auto-refresh every 30s (only when tab is visible)
  useEffect(() => {
    if (!linearToken || !selectedProjectId) return;

    const startPolling = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(() => {
        if (document.visibilityState === 'visible') {
          silentRefresh(selectedProjectId);
        }
      }, POLL_INTERVAL_MS);
    };

    startPolling();

    // Restart polling when tab becomes visible (in case interval drifted while hidden)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        silentRefresh(selectedProjectId);
        startPolling();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [linearToken, selectedProjectId, silentRefresh]);

  // Ctrl+Z / Cmd+Z undo handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        undo();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [undo]);

  return {
    projects,
    selectedProjectId,
    projectName,
    linearProjectUrl,
    isLinkedInLinear,
    linkingToLinear,
    addProjectLinkToLinear,
    tasks,
    unscheduledTasks,
    filteredTasks,
    milestones,
    workflowStates,
    assignees,
    statuses,
    loading,
    error,
    lastSynced,
    dayWidth,
    effectiveDayWidth,
    timeScale,
    setTimeScale,
    groupBy,
    filters,
    setFilters,
    setGroupBy,
    selectProject,
    refresh,
    zoomIn,
    zoomOut,
    reschedule,
    rescheduleStart,
    updateMilestoneDate,
    cycleStatus,
    createRelation,
    removeRelation,
    reorderTask,
    undo,
  };
}
