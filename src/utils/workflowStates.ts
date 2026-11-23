import type { Task, WorkflowState } from '@/types';

function normalizeType(type: string | null | undefined): string {
  return (type || '').trim().toLowerCase();
}

function normalizeName(name: string | null | undefined): string {
  return (name || '').trim().toLowerCase();
}

const MENU_TYPE_ORDER: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
  duplicate: 6,
};

/**
 * Every workflow state of a team for the status dropdown, in progression order
 * (triage -> backlog -> unstarted -> started -> completed -> canceled -> duplicate), then by `position` and name.
 */
export function sortWorkflowStatesForMenu(states: WorkflowState[]): WorkflowState[] {
  const rank = (type: string) => MENU_TYPE_ORDER[normalizeType(type)] ?? 99;
  return states
    .slice()
    .sort((a, b) => rank(a.type) - rank(b.type) || a.position - b.position || a.name.localeCompare(b.name));
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
