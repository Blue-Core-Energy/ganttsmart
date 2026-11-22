import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import AuthPage from '@/components/AuthPage';
import FilterBar from '@/components/FilterBar';
import GanttChart from '@/components/GanttChart';
import Header from '@/components/Header';
import LinearConnect from '@/components/LinearConnect';
import Onboarding from '@/components/Onboarding';
import StatsRow from '@/components/StatsRow';
import SessionExpired from '@/components/SessionExpired';
import ToastContainer from '@/components/Toast';
import { toastError, toastSuccess } from '@/components/toastStore';
import DetailPanel from '@/components/DetailPanel';
import {
  setBaselinesForPanel,
  setDetailPanelExternalEditState,
  setDetailPanelNonWorkDays,
  setDetailPanelProjectSelectHandler,
  setDetailPanelTaskMap,
  setRemoveRelationHandler,
} from '@/components/detailPanelStore';
import MilestonePanel from '@/components/MilestonePanel';
import NonWorkDaysDialog from '@/components/NonWorkDaysDialog';
import { setMilestoneDateHandler } from '@/components/milestonePanelStore';
import { backend } from '@/backend';
import { useAuth } from '@/hooks/useAuth';
import { useLinearData } from '@/hooks/useLinearData';
import { useNonWorkDays } from '@/hooks/useNonWorkDays';
import { usePlanningHistory } from '@/hooks/usePlanningHistory';
import { useTheme } from '@/hooks/useTheme';
import type { InlineEditHandlers, NewNonWorkDay } from '@/types';
import {
  clearPendingOAuthProject,
  peekPendingOAuthProject,
  readProjectParam,
  syncProjectQueryParam,
} from '@/utils/projectDeepLink';
import { hasActiveRowFilters } from '@/utils/tasks';

function GanttView({
  linearToken,
  onDisconnectLinear,
  onLinearAuthError,
  onSignOut,
}: {
  linearToken: string;
  onDisconnectLinear: () => void | Promise<void>;
  onLinearAuthError: () => Promise<void>;
  onSignOut: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const [initialRequestedProject] = useState<string | null>(
    () => readProjectParam(searchParams.toString()) ?? peekPendingOAuthProject(),
  );

  useEffect(() => {
    clearPendingOAuthProject();
  }, []);

  const [showOnboarding, setShowOnboarding] = useState(() => {
    return !localStorage.getItem('gantt_onboarding_done');
  });

  const {
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
    filteredTasks,
    displayTasks,
    allKnownTasks,
    showExternal,
    setShowExternal,
    allowExternalEdits,
    setAllowExternalEdits,
    milestones,
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
    snapTasksToNonWorkDays,
    updateMilestoneDate,
    cycleStatus,
    loadTeamWorkflowStates,
    loadAssignableUsers,
    setTaskStatus,
    setTaskAssignee,
    renameTask,
    createRelation,
    removeRelation,
    reorderTask,
  } = useLinearData(linearToken, onLinearAuthError, initialRequestedProject);

  // Keep ?project=<selectedProjectId> synchronized in the URL for bookmarkable/shareable deep links
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  useEffect(() => {
    if (!selectedProjectId) return;
    const next = syncProjectQueryParam(selectedProjectId, searchParamsRef.current);
    if (next) setSearchParams(next, { replace: true });
  }, [selectedProjectId, setSearchParams]);

  // Planning history: track baselines and log changes
  const { baselines, syncBaselines, logChange, logStatusTransition } = usePlanningHistory(selectedProjectId);

  // Plan vs Actual overlay (dashed baseline ghost bars) — user preference, persisted
  const [showBaselines, setShowBaselines] = useState(() => localStorage.getItem('gantt_show_baselines') !== '0');
  const handleShowBaselinesChange = useCallback((show: boolean) => {
    setShowBaselines(show);
    localStorage.setItem('gantt_show_baselines', show ? '1' : '0');
  }, []);

  // Sync baselines whenever tasks load
  useEffect(() => {
    if (tasks.length > 0) syncBaselines(tasks);
  }, [tasks, syncBaselines]);

  // Wrap reschedule to log due date changes
  const rescheduleWithHistory = useCallback(
    async (taskUuid: string, newDueDate: string) => {
      const task = tasks.find((t) => t.uuid === taskUuid);
      if (task) logChange(task.id, 'due_date', task.due, newDueDate);
      return reschedule(taskUuid, newDueDate);
    },
    [reschedule, tasks, logChange],
  );

  // Wrap rescheduleStart to log start date changes
  const rescheduleStartWithHistory = useCallback(
    async (taskUuid: string, newStartDate: string) => {
      const task = tasks.find((t) => t.uuid === taskUuid);
      if (task) logChange(task.id, 'start_date', task.startDate, newStartDate);
      return rescheduleStart(taskUuid, newStartDate);
    },
    [rescheduleStart, tasks, logChange],
  );

  // Shared holidays / PTO calendar. Adding an entry snaps affected tasks off the new days.
  const nonWorkDays = useNonWorkDays();
  const [showNonWorkDays, setShowNonWorkDays] = useState(false);
  const openNonWorkDays = useCallback(() => setShowNonWorkDays(true), []);
  const closeNonWorkDays = useCallback(() => setShowNonWorkDays(false), []);

  const handleAddNonWorkDay = useCallback(
    async (input: NewNonWorkDay) => {
      const added = await nonWorkDays.add(input);
      void snapTasksToNonWorkDays([...nonWorkDays.entries, added], added)
        .then((snapped) => {
          if (snapped.length === 0) toastSuccess(`Added ${added.label}`);
          for (const { task, startDate, due } of snapped) {
            if (due) logChange(task.id, 'due_date', task.due, due);
            if (startDate) logChange(task.id, 'start_date', task.startDate, startDate);
          }
        })
        .catch(() => {});
    },
    [nonWorkDays, snapTasksToNonWorkDays, logChange],
  );

  useEffect(() => {
    setDetailPanelNonWorkDays(nonWorkDays.entries);
    return () => setDetailPanelNonWorkDays([]);
  }, [nonWorkDays.entries]);

  // Wrap cycleStatus to log status transitions
  const cycleStatusWithHistory = useCallback(
    async (taskUuid: string) => {
      const task = tasks.find((t) => t.uuid === taskUuid);
      const nextStatus = await cycleStatus(taskUuid);
      if (task && nextStatus) logStatusTransition(task.id, task.status, nextStatus);
    },
    [cycleStatus, tasks, logStatusTransition],
  );

  // Inline cell edits (status dropdown, assignee dropdown, title rename) log to planning history on success
  const inlineEdit = useMemo<InlineEditHandlers>(
    () => ({
      loadWorkflowStates: loadTeamWorkflowStates,
      loadAssignableUsers,
      setStatus: async (taskUuid, state) => {
        const task = allKnownTasks.find((t) => t.uuid === taskUuid);
        const saved = await setTaskStatus(taskUuid, state);
        if (task && saved) logStatusTransition(task.id, task.status, state.name);
      },
      setAssignee: async (taskUuid, user) => {
        const task = allKnownTasks.find((t) => t.uuid === taskUuid);
        const saved = await setTaskAssignee(taskUuid, user);
        if (task && saved) logChange(task.id, 'assignee', task.assignee, user?.name ?? 'Unassigned');
      },
      renameTask: async (taskUuid, title) => {
        const task = allKnownTasks.find((t) => t.uuid === taskUuid);
        const saved = await renameTask(taskUuid, title);
        if (task && saved) logChange(task.id, 'title', task.title, title.trim());
      },
    }),
    [
      allKnownTasks,
      loadTeamWorkflowStates,
      loadAssignableUsers,
      setTaskStatus,
      setTaskAssignee,
      renameTask,
      logStatusTransition,
      logChange,
    ],
  );

  // Register the remove handler for DetailPanel's × buttons
  useEffect(() => {
    setRemoveRelationHandler(removeRelation);
    return () => setRemoveRelationHandler(null);
  }, [removeRelation]);

  // Register the date handler for MilestonePanel's date picker
  useEffect(() => {
    setMilestoneDateHandler(updateMilestoneDate);
    return () => setMilestoneDateHandler(null);
  }, [updateMilestoneDate]);

  // Keep DetailPanel's baselines, task lookup, project jump, and external edit toggle in sync
  useEffect(() => {
    setBaselinesForPanel(baselines);
  }, [baselines]);

  useEffect(() => {
    setDetailPanelTaskMap(allKnownTasks);
  }, [allKnownTasks]);

  useEffect(() => {
    setDetailPanelProjectSelectHandler(selectProject);
    return () => setDetailPanelProjectSelectHandler(null);
  }, [selectProject]);

  useEffect(() => {
    setDetailPanelExternalEditState(allowExternalEdits, setAllowExternalEdits);
    return () => setDetailPanelExternalEditState(false, null);
  }, [allowExternalEdits, setAllowExternalEdits]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="dialog"]') || document.querySelector('[role="dialog"]')) return;
      // Inline cell editors (title input, status/assignee menus) own the keyboard while open
      if (target?.closest('[data-inline-edit], [data-inline-menu]') || document.querySelector('[data-inline-menu]')) {
        return;
      }
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        if (e.key === 'Escape' && tag === 'INPUT') {
          setFilters({ ...filters, search: '' });
          target?.blur();
        }
        return;
      }
      if (e.key === 'r' && !e.ctrlKey && !e.metaKey) refresh();
      if (e.key === '+' || e.key === '=') zoomIn();
      if (e.key === '-' || e.key === '_') zoomOut();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [refresh, filters, setFilters, zoomIn, zoomOut]);

  const completeOnboarding = () => {
    setShowOnboarding(false);
    localStorage.setItem('gantt_onboarding_done', '1');
  };

  return (
    <div className="h-screen flex flex-col bg-bg-primary overflow-hidden print:h-auto print:block print:overflow-visible">
      {showOnboarding && <Onboarding onComplete={completeOnboarding} />}

      <Header
        projectName={projectName}
        loading={loading}
        lastSynced={lastSynced}
        onRefresh={refresh}
        onDisconnectLinear={onDisconnectLinear}
        onSignOut={onSignOut}
        theme={theme}
        onThemeChange={setTheme}
        projectId={selectedProjectId}
        projects={projects}
        onSelectProject={selectProject}
        linearToken={linearToken}
        linearProjectUrl={linearProjectUrl}
        isLinkedInLinear={isLinkedInLinear}
        linkingToLinear={linkingToLinear}
        onAddToLinear={addProjectLinkToLinear}
        onOpenNonWorkDays={openNonWorkDays}
        nonWorkDayCount={nonWorkDays.entries.length}
      />

      <FilterBar
        assignees={assignees}
        statuses={statuses}
        filters={filters}
        onFiltersChange={setFilters}
        totalCount={tasks.length}
        filteredCount={filteredTasks.length}
        showBaselines={showBaselines}
        onShowBaselinesChange={handleShowBaselinesChange}
        externalCount={externalTasks.length}
        showExternal={showExternal}
        onShowExternalChange={setShowExternal}
        allowExternalEdits={allowExternalEdits}
        onAllowExternalEditsChange={setAllowExternalEdits}
      />

      <StatsRow tasks={filteredTasks} />

      <div className="flex-1 min-h-0 overflow-hidden print:overflow-visible">
        <GanttChart
          tasks={displayTasks}
          unscheduledTasks={unscheduledTasks}
          milestones={milestones}
          loading={loading}
          error={error}
          dayWidth={dayWidth}
          onDayWidthChange={setDayWidth}
          timeScale={timeScale}
          onReschedule={rescheduleWithHistory}
          onRescheduleStart={rescheduleStartWithHistory}
          onCycleStatus={cycleStatusWithHistory}
          inlineEdit={inlineEdit}
          onCreateRelation={createRelation}
          onReorder={reorderTask}
          onUpdateMilestoneDate={updateMilestoneDate}
          baselines={showBaselines ? baselines : undefined}
          dateFrom={filters.dateFrom}
          dateTo={filters.dateTo}
          externalTasksForViolations={externalTasks}
          allowExternalEdits={allowExternalEdits}
          onSelectProject={selectProject}
          projectName={projectName}
          ignoreCollapsed={hasActiveRowFilters(filters)}
          nonWorkDays={nonWorkDays.entries}
        />
      </div>

      <DetailPanel />
      <MilestonePanel />
      {showNonWorkDays && (
        <NonWorkDaysDialog
          entries={nonWorkDays.entries}
          assignees={assignees}
          loaded={nonWorkDays.loaded}
          shared={backend.capabilities.sharedNonWorkDays}
          onAdd={handleAddNonWorkDay}
          onRemove={nonWorkDays.remove}
          onClose={closeNonWorkDays}
        />
      )}
      <ToastContainer />
    </div>
  );
}

export default function App() {
  const {
    user,
    loading,
    linearToken,
    linearError,
    signedOutMessage,
    connectLinear,
    signUp,
    signIn,
    signInWithGoogle,
    signOut,
    refreshLinearToken,
    disconnectLinear,
  } = useAuth();

  // Linear rejected the access token: try a refresh first, and only disconnect
  // if the server says the user has to reconnect. A transient refresh failure
  // keeps the connection (a retry is scheduled in useAuth).
  const handleLinearAuthError = useCallback(async () => {
    let newToken: string | null;
    try {
      newToken = await refreshLinearToken();
    } catch {
      toastError('Could not refresh the Linear connection. Retrying shortly.');
      return;
    }
    if (newToken === null) await disconnectLinear();
  }, [refreshLinearToken, disconnectLinear]);

  // Initialize theme on app load (applies class to <html> even on auth pages)
  useTheme();

  if (loading) {
    return (
      <div className="fixed inset-0 bg-bg-primary flex items-center justify-center">
        <div className="w-10 h-10 border-3 border-border-primary border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    // Only backends with password login (Supabase) can sign in here; behind IAP a reload signs in again
    if (backend.capabilities.passwordLogin && signIn && signUp && signInWithGoogle) {
      return <AuthPage onSignIn={signIn} onSignUp={signUp} onGoogleSignIn={signInWithGoogle} />;
    }
    return <SessionExpired message={signedOutMessage ?? undefined} />;
  }

  if (!linearToken) {
    return <LinearConnect userEmail={user.email} error={linearError} onConnect={connectLinear} onSignOut={signOut} />;
  }

  return (
    <GanttView
      linearToken={linearToken}
      onDisconnectLinear={disconnectLinear}
      onLinearAuthError={handleLinearAuthError}
      onSignOut={signOut}
    />
  );
}
