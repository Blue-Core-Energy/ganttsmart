import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DebounceCancelled,
  type ProjectExternalLink,
  createIssueRelation,
  createProjectExternalLink,
  fetchAssignableUsers,
  fetchIssues,
  fetchProjectExternalLinks,
  fetchProjects,
  fetchWorkflowStates,
  findActiveExternalLink,
  removeIssueRelation,
  updateIssueAssignee,
  updateIssueDueDate,
  updateIssueSchedule,
  updateIssueStartDate,
  updateIssueState,
  updateIssueTitle,
  updateMilestoneTargetDate,
} from '@/api/linear';
import { toast, toastError, toastSuccess } from '@/components/toastStore';
import type { AssignableUser, Filters, Milestone, DayOff, Project, Task, WorkflowState } from '@/types';
import { buildProjectDeepLink, resolveProjectId } from '@/utils/projectDeepLink';
import { clampDayWidth, DEFAULT_DAY_WIDTH, deriveTimeScale, ZOOM_STEP, zoomDayWidth } from '@/utils/timelineZoom';
import { filterExternalTasks, mergeTasksWithExternalOrder, pruneUnlinkedExternalTasks } from '@/utils/crossProject';
import { planDayOffSnap, saveScheduleSnap, type ScheduleSnap } from '@/utils/daysOff';
import { applyCustomOrder, filterTasks, isTaskDone, reorderWithinHierarchy } from '@/utils/tasks';
import { applyWorkflowStateToTask, findWorkflowStateForTask } from '@/utils/workflowStates';

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

interface UndoCommand {
  id: string;
  targetKey: string;
  label: string;
  revertLocal: () => void;
  revertPersist?: (() => Promise<void>) | null;
  rollbackRevert?: () => void;
}

interface MutateTaskFieldParams {
  taskUuid: string;
  apply: (task: Task) => Task;
  /** Reads the fields touched by `apply`, so they can be restored without touching other edits */
  fields: (task: Task) => Partial<Task>;
  validate?: (task: Task) => string | null;
  persist: () => Promise<void>;
  undoPersist?: ((task: Task) => Promise<void>) | null;
  successMessage: string;
  undoLabel: string;
  failureMessage: string;
  promoteUnscheduled?: boolean;
  onRetry?: () => Promise<boolean>;
}

let undoIdCounter = 0;
function nextUndoId(): string {
  undoIdCounter = (undoIdCounter + 1) % 1_000_000;
  return `undo-${Date.now()}-${undoIdCounter}`;
}

export function useLinearData(linearToken: string, onAuthError?: () => void, requestedProjectId?: string | null) {
  const linearTokenRef = useRef(linearToken);
  linearTokenRef.current = linearToken;
  const onAuthErrorRef = useRef(onAuthError);
  onAuthErrorRef.current = onAuthError;
  const undoQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [linearProjectUrl, setLinearProjectUrl] = useState<string | null>(null);
  const [projectExternalLinks, setProjectExternalLinks] = useState<ProjectExternalLink[]>([]);
  const [linkingToLinear, setLinkingToLinear] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [unscheduledTasks, setUnscheduledTasks] = useState<Task[]>([]);
  const [externalTasks, setExternalTasks] = useState<Task[]>([]);
  const [externalUnscheduledTasks, setExternalUnscheduledTasks] = useState<Task[]>([]);
  const [showExternal, setShowExternalState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('gantt_show_external') !== '0';
    } catch {
      return true;
    }
  });
  const [allowExternalEdits, setAllowExternalEdits] = useState(false);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [workflowStatesByTeam, setWorkflowStatesByTeam] = useState<Record<string, WorkflowState[]>>({});
  const workflowStates = useMemo(() => Object.values(workflowStatesByTeam).flat(), [workflowStatesByTeam]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastSynced, setLastSynced] = useState('');
  const [dayWidth, setDayWidthState] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem('gantt_day_width'));
      return Number.isFinite(stored) && stored > 0 ? clampDayWidth(stored) : DEFAULT_DAY_WIDTH;
    } catch {
      return DEFAULT_DAY_WIDTH;
    }
  });
  const [filters, setFilters] = useState<Filters>({
    assignee: '',
    status: '',
    search: '',
    dateFrom: '',
    dateTo: '',
    showCompleted: true,
  });

  const initialLoadDone = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingMutations = useRef(0); // guards polling from overwriting optimistic state
  const activeProjectIdRef = useRef('');

  // Undo stack: stores undo commands
  const undoStackRef = useRef<UndoCommand[]>([]);

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

  const setShowExternal = useCallback((show: boolean) => {
    setShowExternalState(show);
    try {
      localStorage.setItem('gantt_show_external', show ? '1' : '0');
    } catch {
      // localStorage unavailable — toggle still applies for this session
    }
  }, []);

  // Local tasks in display order (used for StatsRow and baselines)
  const orderedTasks = useMemo(() => applyCustomOrder(tasks, customOrder), [tasks, customOrder]);

  const filteredTasks = useMemo(() => filterTasks(orderedTasks, filters), [orderedTasks, filters]);

  // Unified display order including cross-project dependency ghost tasks
  const orderedAllTasks = useMemo(
    () => mergeTasksWithExternalOrder(tasks, externalTasks, customOrder),
    [tasks, externalTasks, customOrder],
  );

  const visibleExternalTasks = useMemo(
    () => filterExternalTasks(externalTasks, filteredTasks, filters, showExternal),
    [externalTasks, filteredTasks, filters, showExternal],
  );

  const displayTasks = useMemo(() => {
    const visibleLocalIds = new Set(filteredTasks.map((t) => t.uuid));
    const visibleExtIds = new Set(visibleExternalTasks.map((t) => t.uuid));
    return orderedAllTasks.filter((t) => (t.isExternal ? visibleExtIds.has(t.uuid) : visibleLocalIds.has(t.uuid)));
  }, [orderedAllTasks, filteredTasks, visibleExternalTasks]);

  const visibleUuids = useMemo(() => new Set(displayTasks.map((t) => t.uuid)), [displayTasks]);

  const allKnownTasks = useMemo(
    () => [...tasks, ...unscheduledTasks, ...externalTasks, ...externalUnscheduledTasks],
    [tasks, unscheduledTasks, externalTasks, externalUnscheduledTasks],
  );

  // Move a task (local or external ghost row) next to another in the display order and persist it.
  // A parent moves with its sub-issues; a sub-issue can only move among its siblings. Sub-issues whose parent
  // is filtered out are top-level rows on screen, so they move among the visible top-level rows.
  const reorderTask = useCallback(
    (draggedUuid: string, targetUuid: string, placeAfter: boolean) => {
      if (draggedUuid === targetUuid) return;
      const order = reorderWithinHierarchy(orderedAllTasks, draggedUuid, targetUuid, placeAfter, visibleUuids);
      if (!order) {
        toast('Sub-issues can only be reordered within their parent');
        return;
      }
      setCustomOrder(order);
      if (selectedProjectId) {
        try {
          localStorage.setItem(customOrderKey(selectedProjectId), JSON.stringify(order));
        } catch {
          // localStorage full/unavailable — order still applies for this session
        }
      }
    },
    [orderedAllTasks, visibleUuids, selectedProjectId],
  );

  const pushUndoCommand = useCallback((command: UndoCommand) => {
    undoStackRef.current.push(command);
    // Keep max 20 undo entries
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
  }, []);

  const executeUndo = useCallback(async (targetId?: string): Promise<boolean> => {
    let command: UndoCommand | undefined;
    if (targetId) {
      const idx = undoStackRef.current.findIndex((c) => c.id === targetId);
      if (idx === -1) return false;
      const cmd = undoStackRef.current[idx];
      // Check if this command is superseded by a newer command for the same targetKey
      const isSuperseded = undoStackRef.current.some((c, i) => i > idx && c.targetKey === cmd.targetKey);
      // Remove it from the stack so clicking the toast button can't be retried
      undoStackRef.current.splice(idx, 1);
      if (isSuperseded) {
        // Superseded by a newer edit on the same entity — do not revert over newer state
        return false;
      }
      command = cmd;
    } else {
      command = undoStackRef.current.pop();
    }
    if (!command) return false;

    const originProjectId = activeProjectIdRef.current;
    command.revertLocal();

    if (command.revertPersist) {
      pendingMutations.current++;
      const runPersist = async (): Promise<boolean> => {
        try {
          await command.revertPersist!();
          if (activeProjectIdRef.current !== originProjectId) return false;
          if (!targetId) {
            toastSuccess(`Undone: ${command.label}`);
          }
          return true;
        } catch (e) {
          if (e instanceof DebounceCancelled) return false;
          if (activeProjectIdRef.current === originProjectId) {
            command.rollbackRevert?.();
          }
          const msg = (e as Error).message || '';
          if (msg.includes('authentication expired')) {
            toastError('Linear session expired. Reconnecting...');
            onAuthErrorRef.current?.();
          } else {
            toastError(`Failed to undo ${command.label}: ${msg}`);
          }
          return false;
        } finally {
          pendingMutations.current--;
        }
      };

      undoQueueRef.current = undoQueueRef.current.then(runPersist, runPersist);
      return await (undoQueueRef.current as Promise<boolean>);
    } else {
      if (!targetId) {
        toastSuccess(`Undone: ${command.label}`);
      }
      return true;
    }
  }, []);

  const undo = useCallback((): Promise<boolean> => {
    return executeUndo();
  }, [executeUndo]);

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
  const silentRefresh = useCallback(async (projectId: string) => {
    const token = linearTokenRef.current;
    if (!token || !projectId) return;
    if (pendingMutations.current > 0) return; // don't clobber optimistic state
    try {
      const result = await fetchIssues(token, projectId);
      if (pendingMutations.current > 0) return; // check again after fetch to avoid overwriting in-flight optimistic state
      if (activeProjectIdRef.current && activeProjectIdRef.current !== projectId) return;
      setTasks(result.tasks);
      setUnscheduledTasks(result.unscheduledTasks);
      setExternalTasks(result.externalTasks);
      setExternalUnscheduledTasks(result.externalUnscheduledTasks);
      setProjectName(result.projectName);
      setMilestones(result.milestones);
      setLastSynced(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) {
      // Auto-disconnect on auth expiry, otherwise silent
      if ((e as Error).message?.includes('authentication expired')) {
        onAuthErrorRef.current?.();
      }
    }
  }, []);

  const loadIssues = useCallback(
    async (projectId: string) => {
      if (!linearToken || !projectId) return;
      setLoading(true);
      setError('');
      try {
        const result = await fetchIssues(linearToken, projectId);
        if (activeProjectIdRef.current && activeProjectIdRef.current !== projectId) return;
        setTasks(result.tasks);
        setUnscheduledTasks(result.unscheduledTasks);
        setExternalTasks(result.externalTasks);
        setExternalUnscheduledTasks(result.externalUnscheduledTasks);
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
        if (activeProjectIdRef.current && activeProjectIdRef.current !== projectId) return;
        const msg = (e as Error).message;
        setError(msg);
        setTasks([]);
        setUnscheduledTasks([]);
        setExternalTasks([]);
        setExternalUnscheduledTasks([]);
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
      setExternalTasks([]);
      setExternalUnscheduledTasks([]);
      setAllowExternalEdits(false);
      localStorage.setItem('linear_selected_project', id);
      setFilters({
        assignee: '',
        status: '',
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

  /** Zoom is a single continuous px-per-day value; the header granularity follows it */
  const setDayWidth = useCallback((next: number | ((current: number) => number)) => {
    setDayWidthState((current) => {
      const value = clampDayWidth(typeof next === 'function' ? next(current) : next);
      try {
        localStorage.setItem('gantt_day_width', String(value));
      } catch {
        // localStorage unavailable — the zoom still applies for this session
      }
      return value;
    });
  }, []);

  const zoomIn = useCallback(() => setDayWidth((w) => zoomDayWidth(w, ZOOM_STEP)), [setDayWidth]);
  const zoomOut = useCallback(() => setDayWidth((w) => zoomDayWidth(w, 1 / ZOOM_STEP)), [setDayWidth]);

  const timeScale = useMemo(() => deriveTimeScale(dayWidth), [dayWidth]);

  // Shared optimistic field-level mutation pipeline
  const mutateTaskField = useCallback(
    async ({
      taskUuid,
      apply,
      fields,
      validate,
      persist,
      undoPersist,
      successMessage,
      undoLabel,
      failureMessage,
      promoteUnscheduled,
      onRetry,
    }: MutateTaskFieldParams): Promise<boolean> => {
      if (!linearTokenRef.current) return false;

      const fromUnscheduled = unscheduledTasks.find((t) => t.uuid === taskUuid);
      const fromExternalUnscheduled = externalUnscheduledTasks.find((t) => t.uuid === taskUuid);
      const fromExternalScheduled = externalTasks.find((t) => t.uuid === taskUuid);
      const fromExternal = fromExternalScheduled || fromExternalUnscheduled;
      const task = tasks.find((t) => t.uuid === taskUuid) || fromUnscheduled || fromExternal;

      if (!task) return false;

      if (fromExternal && !allowExternalEdits) {
        toast('Unlock "Edit external" to modify cross-project issues', 'info');
        return false;
      }

      if (validate) {
        const valError = validate(task);
        if (valError) {
          toastError(valError);
          return false;
        }
      }

      const isPromoteLocal = Boolean(fromUnscheduled && promoteUnscheduled);
      const isPromoteExternal = Boolean(fromExternalUnscheduled && promoteUnscheduled);
      const snapshot = fields(task);
      const appliedTask = isPromoteExternal ? { ...apply(task), isUnscheduledExternal: undefined } : apply(task);
      const appliedFields = fields(appliedTask);

      const applyToCollection = () => {
        if (isPromoteLocal) {
          setUnscheduledTasks((prev) => prev.filter((t) => t.uuid !== taskUuid));
          setTasks((prev) =>
            prev.some((t) => t.uuid === taskUuid)
              ? prev.map((t) => (t.uuid === taskUuid ? { ...t, ...appliedFields } : t))
              : [...prev, appliedTask],
          );
        } else if (isPromoteExternal) {
          setExternalUnscheduledTasks((prev) => prev.filter((t) => t.uuid !== taskUuid));
          setExternalTasks((prev) =>
            prev.some((t) => t.uuid === taskUuid)
              ? prev.map((t) => (t.uuid === taskUuid ? { ...t, ...appliedFields } : t))
              : [...prev, appliedTask],
          );
        } else if (fromExternalScheduled) {
          setExternalTasks((prev) => prev.map((t) => (t.uuid === taskUuid ? { ...t, ...appliedFields } : t)));
        } else if (fromExternalUnscheduled) {
          setExternalUnscheduledTasks((prev) =>
            prev.map((t) => (t.uuid === taskUuid ? { ...t, ...appliedFields } : t)),
          );
        } else if (fromUnscheduled) {
          setUnscheduledTasks((prev) => prev.map((t) => (t.uuid === taskUuid ? { ...t, ...appliedFields } : t)));
        } else {
          setTasks((prev) => prev.map((t) => (t.uuid === taskUuid ? { ...t, ...appliedFields } : t)));
        }
      };

      const revertCollection = () => {
        if (isPromoteLocal) {
          setTasks((prev) => prev.filter((t) => t.uuid !== taskUuid));
          setUnscheduledTasks((prev) =>
            prev.some((t) => t.uuid === taskUuid)
              ? prev.map((t) => (t.uuid === taskUuid ? { ...t, ...snapshot } : t))
              : [...prev, { ...task, ...snapshot }],
          );
        } else if (isPromoteExternal) {
          setExternalTasks((prev) => prev.filter((t) => t.uuid !== taskUuid));
          setExternalUnscheduledTasks((prev) =>
            prev.some((t) => t.uuid === taskUuid)
              ? prev.map((t) => (t.uuid === taskUuid ? { ...t, ...snapshot } : t))
              : [...prev, { ...task, ...snapshot, isUnscheduledExternal: true }],
          );
        } else if (fromExternalScheduled) {
          setExternalTasks((prev) => prev.map((t) => (t.uuid === taskUuid ? { ...t, ...snapshot } : t)));
        } else if (fromExternalUnscheduled) {
          setExternalUnscheduledTasks((prev) => prev.map((t) => (t.uuid === taskUuid ? { ...t, ...snapshot } : t)));
        } else if (fromUnscheduled) {
          setUnscheduledTasks((prev) => prev.map((t) => (t.uuid === taskUuid ? { ...t, ...snapshot } : t)));
        } else {
          setTasks((prev) => prev.map((t) => (t.uuid === taskUuid ? { ...t, ...snapshot } : t)));
        }
      };

      applyToCollection();

      const originProjectId = activeProjectIdRef.current;
      pendingMutations.current++;
      try {
        await persist();
        if (activeProjectIdRef.current !== originProjectId) return false;
        const undoId = nextUndoId();
        pushUndoCommand({
          id: undoId,
          targetKey: `task:${taskUuid}`,
          label: `${task.id} ${undoLabel}`,
          revertLocal: revertCollection,
          revertPersist: undoPersist ? () => undoPersist(task) : null,
          rollbackRevert: applyToCollection,
        });
        toast(successMessage, 'success', {
          label: 'Undo',
          onClick: () => {
            void executeUndo(undoId);
          },
        });
        return true;
      } catch (e) {
        if (e instanceof DebounceCancelled) return false; // superseded by a newer drag — don't rollback
        if (activeProjectIdRef.current === originProjectId) {
          revertCollection();
        }
        const msg = (e as Error).message || '';
        if (msg.includes('authentication expired')) {
          toastError('Linear session expired. Reconnecting...');
          onAuthErrorRef.current?.();
        } else {
          toastError(`${failureMessage}: ${msg}`, onRetry);
        }
        return false;
      } finally {
        pendingMutations.current--;
      }
    },
    [
      tasks,
      unscheduledTasks,
      externalTasks,
      externalUnscheduledTasks,
      allowExternalEdits,
      pushUndoCommand,
      executeUndo,
    ],
  );

  // Optimistic reschedule (due date) with rollback + undo.
  // Also handles "promoting" an unscheduled task: if the uuid lives in unscheduledTasks,
  // we move it into tasks with the new explicit due date.
  const reschedule = useCallback(
    async (taskUuid: string, newDueDate: string): Promise<boolean> => {
      return mutateTaskField({
        taskUuid,
        promoteUnscheduled: true,
        validate: (t) => (t.startDate && newDueDate < t.startDate ? 'Due date cannot be before start date' : null),
        apply: (t) => ({ ...t, due: newDueDate, isDueImplicit: undefined }),
        fields: (t) => ({ due: t.due, isDueImplicit: t.isDueImplicit }),
        persist: () => updateIssueDueDate(linearTokenRef.current, taskUuid, newDueDate),
        undoPersist: (task) => {
          const token = linearTokenRef.current;
          if (!token) return Promise.resolve();
          const prevDue = task.due && !task.isDueImplicit ? task.due : null;
          return updateIssueDueDate(token, taskUuid, prevDue);
        },
        successMessage: 'Due date updated',
        undoLabel: 'due date',
        failureMessage: 'Failed to update due date',
        onRetry: () => reschedule(taskUuid, newDueDate),
      });
    },
    [mutateTaskField],
  );

  // Optimistic reschedule (start date) with rollback + undo
  const rescheduleStart = useCallback(
    async (taskUuid: string, newStartDate: string | null): Promise<boolean> => {
      return mutateTaskField({
        taskUuid,
        promoteUnscheduled: false,
        validate: (t) => (newStartDate && t.due && newStartDate > t.due ? 'Start date cannot be after due date' : null),
        apply: (t) => ({ ...t, startDate: newStartDate }),
        fields: (t) => ({ startDate: t.startDate }),
        persist: () => updateIssueStartDate(linearTokenRef.current, taskUuid, newStartDate),
        undoPersist: (task) => {
          const token = linearTokenRef.current;
          if (!token) return Promise.resolve();
          return updateIssueStartDate(token, taskUuid, task.startDate);
        },
        successMessage: newStartDate ? 'Start date updated' : 'Start date cleared',
        undoLabel: 'start date',
        failureMessage: 'Failed to update start date',
        onRetry: () => rescheduleStart(taskUuid, newStartDate),
      });
    },
    [mutateTaskField],
  );

  // Optimistic reschedule for both start and due dates (whole-bar move) with rollback + undo
  const rescheduleRange = useCallback(
    async (taskUuid: string, newDueDate: string, newStartDate: string | null): Promise<boolean> => {
      return mutateTaskField({
        taskUuid,
        promoteUnscheduled: true,
        validate: () => (newStartDate && newStartDate > newDueDate ? 'Start date cannot be after due date' : null),
        apply: (t) => ({ ...t, due: newDueDate, startDate: newStartDate, isDueImplicit: undefined }),
        fields: (t) => ({ due: t.due, startDate: t.startDate, isDueImplicit: t.isDueImplicit }),
        persist: () =>
          updateIssueSchedule(linearTokenRef.current, taskUuid, { dueDate: newDueDate, startDate: newStartDate }),
        undoPersist: (task) => {
          const token = linearTokenRef.current;
          if (!token) return Promise.resolve();
          const prevDue = task.isDueImplicit ? null : task.due || null;
          return updateIssueSchedule(token, taskUuid, {
            dueDate: prevDue,
            startDate: task.startDate,
          });
        },
        successMessage: 'Schedule updated',
        undoLabel: 'schedule',
        failureMessage: 'Failed to update schedule',
        onRetry: () => rescheduleRange(taskUuid, newDueDate, newStartDate),
      });
    },
    [mutateTaskField],
  );

  /**
   * Moves editable tasks whose start or due date sits on the just-added day(s) off to the next
   * workday: updates the chart right away, saves to Linear, and offers one Undo for the batch.
   * `entries` is the whole calendar including `added`. Returns the snaps that were saved.
   */
  const snapTasksToDaysOff = useCallback(
    async (entries: DayOff[], added: DayOff): Promise<ScheduleSnap[]> => {
      const token = linearTokenRef.current;
      if (!token) return [];
      const plan = planDayOffSnap(tasks, entries, added);
      if (plan.length === 0) return [];

      const planByUuid = new Map(plan.map((p) => [p.task.uuid, p]));
      const applySnap = (t: Task, p: ScheduleSnap): Task => ({
        ...t,
        ...(p.startDate ? { startDate: p.startDate } : {}),
        ...(p.due ? { due: p.due, isDueImplicit: undefined } : {}),
      });
      setTasks((prev) => prev.map((t) => (planByUuid.has(t.uuid) ? applySnap(t, planByUuid.get(t.uuid)!) : t)));

      const originProjectId = activeProjectIdRef.current;
      pendingMutations.current++;
      try {
        const results = await Promise.all(
          plan.map((p) =>
            saveScheduleSnap(
              p,
              (due) => updateIssueDueDate(linearTokenRef.current, p.task.uuid, due),
              (start) => updateIssueStartDate(linearTokenRef.current, p.task.uuid, start),
            ),
          ),
        );
        if (activeProjectIdRef.current !== originProjectId) return [];
        const saved = results.filter((r) => r.applied.due || r.applied.startDate).map((r) => r.applied);
        const failed = results.filter((r) => r.failed);

        if (failed.length > 0) {
          // Roll back only the fields that did not save; a field that did save stays in the chart,
          // Undo and history so they match Linear.
          const failedByUuid = new Map(failed.map((r) => [r.applied.task.uuid, r.applied]));
          setTasks((prev) =>
            prev.map((t) => {
              const applied = failedByUuid.get(t.uuid);
              if (!applied) return t;
              const original = applied.task;
              const snap = planByUuid.get(t.uuid)!;
              return {
                ...t,
                ...(snap.startDate && !applied.startDate ? { startDate: original.startDate } : {}),
                ...(snap.due && !applied.due ? { due: original.due, isDueImplicit: original.isDueImplicit } : {}),
              };
            }),
          );
          toastError(
            `Could not fully move ${failed.length} ${failed.length === 1 ? 'task' : 'tasks'} off ${added.label}`,
          );
        }
        if (saved.length === 0) return [];

        const undoId = nextUndoId();
        const savedByUuid = new Map(saved.map((p) => [p.task.uuid, p]));
        pushUndoCommand({
          id: undoId,
          targetKey: `snap:${added.label}`,
          label: `${saved.length} ${saved.length === 1 ? 'task' : 'tasks'} moved off ${added.label}`,
          revertLocal: () => {
            setTasks((prev) =>
              prev.map((t) => {
                const p = savedByUuid.get(t.uuid);
                if (!p) return t;
                const original = p.task;
                return {
                  ...t,
                  ...(p.startDate ? { startDate: original.startDate } : {}),
                  ...(p.due ? { due: original.due, isDueImplicit: original.isDueImplicit } : {}),
                };
              }),
            );
          },
          revertPersist: async () => {
            const activeToken = linearTokenRef.current;
            if (!activeToken) return;
            for (const p of saved) {
              if (p.due && p.startDate) {
                await updateIssueSchedule(activeToken, p.task.uuid, {
                  dueDate: p.task.due,
                  startDate: p.task.startDate,
                });
              } else if (p.startDate) {
                await updateIssueStartDate(activeToken, p.task.uuid, p.task.startDate);
              } else if (p.due) {
                await updateIssueDueDate(activeToken, p.task.uuid, p.task.due);
              }
            }
          },
          rollbackRevert: () => {
            setTasks((prev) =>
              prev.map((t) => {
                const p = savedByUuid.get(t.uuid);
                if (!p) return t;
                return {
                  ...t,
                  ...(p.startDate ? { startDate: p.startDate } : {}),
                  ...(p.due ? { due: p.due, isDueImplicit: undefined } : {}),
                };
              }),
            );
          },
        });
        toast(
          `${added.label} added: moved ${saved.length} ${saved.length === 1 ? 'task' : 'tasks'} to the next workday`,
          'success',
          {
            label: 'Undo',
            onClick: () => {
              void executeUndo(undoId);
            },
          },
        );
        return saved;
      } finally {
        pendingMutations.current--;
      }
    },
    [tasks, pushUndoCommand, executeUndo],
  );

  // Optimistic milestone move (drag on the chart) with rollback + undo
  const updateMilestoneDate = useCallback(
    async (milestoneId: string, newTargetDate: string) => {
      const token = linearTokenRef.current;
      if (!token) return;

      const milestone = milestones.find((m) => m.id === milestoneId);
      if (!milestone) return;

      const prevTargetDate = milestone.targetDate;

      setMilestones((prev) => prev.map((m) => (m.id === milestoneId ? { ...m, targetDate: newTargetDate } : m)));

      const originProjectId = activeProjectIdRef.current;
      pendingMutations.current++;
      try {
        await updateMilestoneTargetDate(token, milestoneId, newTargetDate);
        if (activeProjectIdRef.current !== originProjectId) return;
        const undoId = nextUndoId();
        pushUndoCommand({
          id: undoId,
          targetKey: `milestone:${milestoneId}`,
          label: `${milestone.name} moved`,
          revertLocal: () => {
            setMilestones((prev) => prev.map((m) => (m.id === milestoneId ? { ...m, targetDate: prevTargetDate } : m)));
          },
          revertPersist: prevTargetDate
            ? () => updateMilestoneTargetDate(linearTokenRef.current, milestoneId, prevTargetDate)
            : null,
          rollbackRevert: () => {
            setMilestones((prev) => prev.map((m) => (m.id === milestoneId ? { ...m, targetDate: newTargetDate } : m)));
          },
        });
        toast(`${milestone.name} moved`, 'success', {
          label: 'Undo',
          onClick: () => {
            void executeUndo(undoId);
          },
        });
      } catch (e) {
        if (e instanceof DebounceCancelled) return; // superseded by a newer drag
        if (activeProjectIdRef.current === originProjectId) {
          setMilestones((prev) => prev.map((m) => (m.id === milestoneId ? { ...m, targetDate: prevTargetDate } : m)));
        }
        const msg = (e as Error).message || '';
        if (msg.includes('authentication expired')) {
          toastError('Linear session expired. Reconnecting...');
          onAuthErrorRef.current?.();
        } else {
          toastError(`Failed to move milestone: ${msg}`, () => updateMilestoneDate(milestoneId, newTargetDate));
        }
      } finally {
        pendingMutations.current--;
      }
    },
    [milestones, pushUndoCommand, executeUndo],
  );

  // Shared optimistic edit for a single issue (local or unlocked external): apply, persist,
  // then record undo + toast; on failure restore the original field values and offer a retry.
  const editTaskField = useCallback(
    (params: {
      taskUuid: string;
      apply: (task: Task) => Task;
      /** Reads the fields touched by `apply`, so they can be restored without touching other edits */
      fields: (task: Task) => Partial<Task>;
      persist: () => Promise<void>;
      undoPersist: (() => Promise<void>) | null;
      successMessage: string;
      undoLabel: string;
      failureMessage: string;
    }): Promise<boolean> => {
      return mutateTaskField({
        ...params,
        onRetry: () => editTaskField(params),
      });
    },
    [mutateTaskField],
  );

  // Workflow states for a team: cached, otherwise fetched on demand
  const loadTeamWorkflowStates = useCallback(
    async (teamId: string): Promise<WorkflowState[]> => {
      const cached = teamId ? workflowStatesByTeam[teamId] : undefined;
      if (cached && cached.length > 0) return cached;
      const token = linearTokenRef.current;
      if (!teamId || !token) return workflowStates;
      const fetched = await fetchWorkflowStates(token, teamId);
      setWorkflowStatesByTeam((prev) => ({ ...prev, [teamId]: fetched }));
      return fetched;
    },
    [workflowStatesByTeam, workflowStates],
  );

  const loadAssignableUsers = useCallback(
    (teamId: string): Promise<AssignableUser[]> => fetchAssignableUsers(linearTokenRef.current, teamId),
    [],
  );

  // Optimistic status change to an explicitly chosen workflow state. Resolves true when persisted.
  const setTaskStatus = useCallback(
    async (taskUuid: string, nextState: WorkflowState): Promise<boolean> => {
      const task = tasks.find((t) => t.uuid === taskUuid) || externalTasks.find((t) => t.uuid === taskUuid);
      if (!task) return false;
      if (task.status === nextState.name && task.statusType === nextState.type) return false;
      const teamStates = (task.teamId && workflowStatesByTeam[task.teamId]) || workflowStates;
      const prevState = findWorkflowStateForTask(task, teamStates);
      const completedAtIso = new Date().toISOString();
      return editTaskField({
        taskUuid,
        apply: (t) => applyWorkflowStateToTask(t, nextState, completedAtIso),
        fields: (t) => ({ status: t.status, statusType: t.statusType, completedAt: t.completedAt }),
        persist: () => updateIssueState(linearTokenRef.current, taskUuid, nextState.id),
        undoPersist: prevState ? () => updateIssueState(linearTokenRef.current, taskUuid, prevState.id) : null,
        successMessage: `Status → ${nextState.name}`,
        undoLabel: 'status',
        failureMessage: 'Failed to update status',
      });
    },
    [tasks, externalTasks, workflowStatesByTeam, workflowStates, editTaskField],
  );

  // Optimistic (re)assignment; `user === null` unassigns
  const setTaskAssignee = useCallback(
    async (taskUuid: string, user: AssignableUser | null): Promise<boolean> => {
      const task = tasks.find((t) => t.uuid === taskUuid) || externalTasks.find((t) => t.uuid === taskUuid);
      if (!task) return false;
      const nextId = user?.id ?? null;
      if ((task.assigneeId ?? null) === nextId && (nextId !== null || task.assignee === 'Unassigned')) return false;
      const prevId = task.assigneeId ?? null;
      return editTaskField({
        taskUuid,
        apply: (t) => ({ ...t, assignee: user?.name ?? 'Unassigned', assigneeId: nextId }),
        fields: (t) => ({ assignee: t.assignee, assigneeId: t.assigneeId }),
        persist: () => updateIssueAssignee(linearTokenRef.current, taskUuid, nextId),
        undoPersist: () => updateIssueAssignee(linearTokenRef.current, taskUuid, prevId),
        successMessage: user ? `Assigned to ${user.name}` : 'Unassigned',
        undoLabel: 'assignee',
        failureMessage: 'Failed to update assignee',
      });
    },
    [tasks, externalTasks, editTaskField],
  );

  // Optimistic rename; empty or unchanged titles are ignored
  const renameTask = useCallback(
    async (taskUuid: string, title: string): Promise<boolean> => {
      const task = tasks.find((t) => t.uuid === taskUuid) || externalTasks.find((t) => t.uuid === taskUuid);
      const nextTitle = title.trim();
      if (!task || !nextTitle || nextTitle === task.title) return false;
      const prevTitle = task.title;
      return editTaskField({
        taskUuid,
        apply: (t) => ({ ...t, title: nextTitle }),
        fields: (t) => ({ title: t.title }),
        persist: () => updateIssueTitle(linearTokenRef.current, taskUuid, nextTitle),
        undoPersist: () => updateIssueTitle(linearTokenRef.current, taskUuid, prevTitle),
        successMessage: `Renamed ${task.id}`,
        undoLabel: 'title',
        failureMessage: 'Failed to rename issue',
      });
    },
    [tasks, externalTasks, editTaskField],
  );

  // Create a "blocks" relation between two tasks (local or cross-project)
  const createRelation = useCallback(
    async (sourceTaskId: string, targetTaskId: string) => {
      if (!linearTokenRef.current) return;

      const sourceTask = allKnownTasks.find((t) => t.id === sourceTaskId);
      const targetTask = allKnownTasks.find((t) => t.id === targetTaskId);
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

      const applyAdd = (prev: Task[]) =>
        prev.map((t) => {
          if (t.id === sourceTaskId) return { ...t, blocks: [...new Set([...t.blocks, targetTaskId])] };
          if (t.id === targetTaskId) return { ...t, blockedBy: [...new Set([...t.blockedBy, sourceTaskId])] };
          return t;
        });

      const applyRemove = (prev: Task[]) =>
        prev.map((t) => {
          if (t.id === sourceTaskId) return { ...t, blocks: t.blocks.filter((id) => id !== targetTaskId) };
          if (t.id === targetTaskId) return { ...t, blockedBy: t.blockedBy.filter((id) => id !== sourceTaskId) };
          return t;
        });

      setTasks(applyAdd);
      setUnscheduledTasks(applyAdd);
      setExternalTasks(applyAdd);
      setExternalUnscheduledTasks(applyAdd);

      const originProjectId = activeProjectIdRef.current;
      pendingMutations.current++;
      try {
        await createIssueRelation(linearTokenRef.current, sourceTask.uuid, targetTask.uuid);
        if (activeProjectIdRef.current !== originProjectId) return;
        const undoId = nextUndoId();
        pushUndoCommand({
          id: undoId,
          targetKey: `relation:${sourceTaskId}:${targetTaskId}`,
          label: `${sourceTaskId} blocks ${targetTaskId}`,
          revertLocal: () => {
            setTasks(applyRemove);
            setUnscheduledTasks(applyRemove);
            setExternalTasks(applyRemove);
            setExternalUnscheduledTasks(applyRemove);
          },
          revertPersist: () => removeIssueRelation(linearTokenRef.current, sourceTask.uuid, targetTask.uuid),
          rollbackRevert: () => {
            setTasks(applyAdd);
            setUnscheduledTasks(applyAdd);
            setExternalTasks(applyAdd);
            setExternalUnscheduledTasks(applyAdd);
          },
        });
        toast(`${sourceTaskId} now blocks ${targetTaskId}`, 'success', {
          label: 'Undo',
          onClick: () => {
            void executeUndo(undoId);
          },
        });
      } catch (e) {
        if (activeProjectIdRef.current === originProjectId) {
          setTasks(applyRemove);
          setUnscheduledTasks(applyRemove);
          setExternalTasks(applyRemove);
          setExternalUnscheduledTasks(applyRemove);
        }
        const msg = (e as Error).message || '';
        if (msg.includes('authentication expired')) {
          toastError('Linear session expired. Reconnecting...');
          onAuthErrorRef.current?.();
        } else {
          toastError(`Failed to create relation: ${msg}`);
        }
      } finally {
        pendingMutations.current--;
      }
    },
    [allKnownTasks, pushUndoCommand, executeUndo],
  );

  // Remove a "blocks" relation between two tasks (supports cross-project dependencies)
  // sourceTaskId = blocker identifier, targetTaskId = blocked identifier
  const removeRelation = useCallback(
    async (sourceTaskId: string, targetTaskId: string) => {
      if (!linearTokenRef.current) return;

      const sourceTask = allKnownTasks.find((t) => t.id === sourceTaskId);
      const targetTask = allKnownTasks.find((t) => t.id === targetTaskId);
      if (!sourceTask || !targetTask) return;

      const sourceWasExternal = sourceTask.isExternal;
      const targetWasExternal = targetTask.isExternal;

      const applyRemove = (prev: Task[]) =>
        prev.map((t) => {
          if (t.id === sourceTaskId) return { ...t, blocks: t.blocks.filter((id) => id !== targetTaskId) };
          if (t.id === targetTaskId) return { ...t, blockedBy: t.blockedBy.filter((id) => id !== sourceTaskId) };
          return t;
        });

      const applyAdd = (prev: Task[]) =>
        prev.map((t) => {
          if (t.id === sourceTaskId) return { ...t, blocks: [...new Set([...t.blocks, targetTaskId])] };
          if (t.id === targetTaskId) return { ...t, blockedBy: [...new Set([...t.blockedBy, sourceTaskId])] };
          return t;
        });

      const applyRemoveLocal = () => {
        setTasks(applyRemove);
        setUnscheduledTasks(applyRemove);
        const updatedLocals = [
          ...tasks.map((t) => (t.id === sourceTaskId || t.id === targetTaskId ? applyRemove([t])[0] : t)),
          ...unscheduledTasks.map((t) => (t.id === sourceTaskId || t.id === targetTaskId ? applyRemove([t])[0] : t)),
        ];
        setExternalTasks((prev) => pruneUnlinkedExternalTasks(applyRemove(prev), updatedLocals));
        setExternalUnscheduledTasks((prev) => pruneUnlinkedExternalTasks(applyRemove(prev), updatedLocals));
      };

      const applyAddLocal = () => {
        setTasks(applyAdd);
        setUnscheduledTasks(applyAdd);
        setExternalTasks((prev) => {
          const updated = applyAdd(prev);
          const currentUuids = new Set(updated.map((t) => t.uuid));
          const toAdd: Task[] = [];
          if (sourceWasExternal && !sourceTask.isUnscheduledExternal && !currentUuids.has(sourceTask.uuid)) {
            toAdd.push(sourceTask);
          }
          if (targetWasExternal && !targetTask.isUnscheduledExternal && !currentUuids.has(targetTask.uuid)) {
            toAdd.push(targetTask);
          }
          return toAdd.length > 0 ? applyAdd([...updated, ...toAdd]) : updated;
        });
        setExternalUnscheduledTasks((prev) => {
          const updated = applyAdd(prev);
          const currentUuids = new Set(updated.map((t) => t.uuid));
          const toAdd: Task[] = [];
          if (sourceWasExternal && sourceTask.isUnscheduledExternal && !currentUuids.has(sourceTask.uuid)) {
            toAdd.push(sourceTask);
          }
          if (targetWasExternal && targetTask.isUnscheduledExternal && !currentUuids.has(targetTask.uuid)) {
            toAdd.push(targetTask);
          }
          return toAdd.length > 0 ? applyAdd([...updated, ...toAdd]) : updated;
        });
      };

      applyRemoveLocal();

      const originProjectId = activeProjectIdRef.current;
      pendingMutations.current++;
      try {
        await removeIssueRelation(linearTokenRef.current, sourceTask.uuid, targetTask.uuid);
        if (activeProjectIdRef.current !== originProjectId) return;
        const undoId = nextUndoId();
        pushUndoCommand({
          id: undoId,
          targetKey: `relation:${sourceTaskId}:${targetTaskId}`,
          label: `${sourceTaskId} no longer blocks ${targetTaskId}`,
          revertLocal: applyAddLocal,
          revertPersist: () => createIssueRelation(linearTokenRef.current, sourceTask.uuid, targetTask.uuid),
          rollbackRevert: applyRemoveLocal,
        });
        toast(`Removed: ${sourceTaskId} → ${targetTaskId}`, 'success', {
          label: 'Undo',
          onClick: () => {
            void executeUndo(undoId);
          },
        });
      } catch (e) {
        if (activeProjectIdRef.current === originProjectId) {
          applyAddLocal();
        }
        const msg = (e as Error).message || '';
        if (msg.includes('authentication expired')) {
          toastError('Linear session expired. Reconnecting...');
          onAuthErrorRef.current?.();
        } else {
          toastError(`Failed to remove relation: ${msg}`);
        }
      } finally {
        pendingMutations.current--;
      }
    },
    [allKnownTasks, tasks, unscheduledTasks, pushUndoCommand, executeUndo],
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
    externalTasks,
    externalUnscheduledTasks,
    filteredTasks,
    displayTasks,
    allKnownTasks,
    showExternal,
    setShowExternal,
    allowExternalEdits,
    setAllowExternalEdits,
    milestones,
    workflowStates,
    assignees,
    statuses,
    loading,
    error,
    lastSynced,
    dayWidth,
    setDayWidth,
    timeScale,
    filters,
    setFilters,
    selectProject,
    refresh,
    zoomIn,
    zoomOut,
    reschedule,
    rescheduleStart,
    rescheduleRange,
    snapTasksToDaysOff,
    updateMilestoneDate,
    loadTeamWorkflowStates,
    loadAssignableUsers,
    setTaskStatus,
    setTaskAssignee,
    renameTask,
    createRelation,
    removeRelation,
    reorderTask,
    undo,
  };
}
