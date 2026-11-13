import type { Task, WorkflowState } from '@/types';
import { isIgnoredIssueState } from './issues';

const WORKFLOW_TYPE_ORDER: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
};

function normalizeType(type: string | null | undefined): string {
  return (type || '').trim().toLowerCase();
}

function normalizeName(name: string | null | undefined): string {
  return (name || '').trim().toLowerCase();
}

function typeRank(type: string | null | undefined): number {
  const normalized = normalizeType(type);
  return WORKFLOW_TYPE_ORDER[normalized] ?? 99;
}

/**
 * Filter out canceled/duplicate workflow states and sort remaining states
 * in canonical workflow progression order (triage -> backlog -> unstarted -> started -> completed),
 * breaking ties by Linear `position` and then name.
 */
export function sortCyclableWorkflowStates(states: WorkflowState[]): WorkflowState[] {
  return states
    .filter((s) => !isIgnoredIssueState(s))
    .slice()
    .sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.position - b.position || a.name.localeCompare(b.name));
}

/**
 * Find the matching WorkflowState for a task's current status.
 */
export function findWorkflowStateForTask(
  task: Pick<Task, 'status' | 'statusType'>,
  states: WorkflowState[],
): WorkflowState | undefined {
  const targetName = normalizeName(task.status);
  const targetType = normalizeType(task.statusType);
  return (
    states.find((s) => normalizeName(s.name) === targetName && normalizeType(s.type) === targetType) ??
    states.find((s) => normalizeName(s.name) === targetName)
  );
}

/**
 * Determine the next workflow state when cycling a task's status bubble.
 * - Skips canceled/duplicate states.
 * - Cycles through backlog -> unstarted -> started -> completed -> backlog (plus any intermediate states).
 * - Advances triage tasks into the main workflow without wrapping completed tasks back into triage.
 * - Returns null when there is no distinct next state to transition to.
 */
export function getNextWorkflowState(
  task: Pick<Task, 'status' | 'statusType'>,
  states: WorkflowState[],
): WorkflowState | null {
  const ordered = sortCyclableWorkflowStates(states);
  if (ordered.length === 0) return null;

  const nonTriage = ordered.filter((s) => normalizeType(s.type) !== 'triage');
  const cyclePool = nonTriage.length >= 2 || nonTriage.length === ordered.length ? nonTriage : ordered;

  const currentType = normalizeType(task.statusType);

  if (currentType === 'triage' && nonTriage.length > 0 && cyclePool === nonTriage) {
    return nonTriage[0];
  }

  const currentIdx = cyclePool.findIndex(
    (s) =>
      normalizeName(s.name) === normalizeName(task.status) &&
      (currentType === '' || normalizeType(s.type) === currentType),
  );
  const resolvedIdx =
    currentIdx !== -1 ? currentIdx : cyclePool.findIndex((s) => normalizeName(s.name) === normalizeName(task.status));

  if (resolvedIdx !== -1) {
    if (cyclePool.length <= 1) return null;
    const next = cyclePool[(resolvedIdx + 1) % cyclePool.length];
    return next.id === cyclePool[resolvedIdx].id && normalizeName(next.name) === normalizeName(task.status)
      ? null
      : next;
  }

  // Fallback if current status isn't in cyclePool (e.g. canceled, duplicate, or unknown)
  const currentRank = typeRank(task.statusType);
  const nextByType = cyclePool.find((s) => typeRank(s.type) > currentRank && currentRank < 99);
  const candidate = nextByType ?? cyclePool[0];
  if (normalizeName(candidate.name) === normalizeName(task.status)) return null;
  return candidate;
}

/**
 * Apply a workflow state transition optimistically to a Task, updating
 * `status`, `statusType`, and `completedAt` so `isTaskDone` immediately reflects the new state.
 */
export function applyWorkflowStateToTask(
  task: Task,
  nextState: Pick<WorkflowState, 'name' | 'type'>,
  completedAtIso: string = new Date().toISOString(),
): Task {
  const isCompleted = normalizeType(nextState.type) === 'completed';
  return {
    ...task,
    status: nextState.name,
    statusType: nextState.type,
    completedAt: isCompleted ? task.completedAt || completedAtIso : undefined,
  };
}
