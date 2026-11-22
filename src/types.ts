export interface Task {
  id: string; // display identifier (e.g., "SEED-14")
  uuid: string; // Linear UUID for mutations
  title: string;
  description: string;
  due: string;
  startDate: string | null;
  priorityVal: number;
  priority: string;
  status: string;
  statusType: string;
  assignee: string;
  /** Linear user UUID of the assignee, or null when unassigned */
  assigneeId?: string | null;
  url: string; // direct Linear URL
  teamId: string; // team UUID for workflow states
  blocks: string[];
  blockedBy: string[];
  progress: number;
  totalChildren: number;
  completedChildren: number;
  completedAt?: string;
  /** Display identifier of the parent issue (e.g., "ENG-100") when this is a sub-issue; matches another task's `id` */
  parentId?: string | null;
  /** True when `due` was derived from project.targetDate (issue has no explicit due date) */
  isDueImplicit?: boolean;
  /** Linear project milestone this issue belongs to, if any */
  milestoneId?: string | null;
  /** Linear project UUID when known (populated for cross-project dependency tasks) */
  projectId?: string | null;
  /** Linear project name when task comes from another project */
  projectName?: string | null;
  /** True when rendered as a cross-project dependency ghost row */
  isExternal?: boolean;
  /** True when an external dependency has no explicit due date or project targetDate */
  isUnscheduledExternal?: boolean;
}

/**
 * A holiday, shutdown or vacation: one date or an inclusive range (`YYYY-MM-DD`).
 * Without `assigneeName` it is company-wide; with it, only that person's tasks skip the days.
 */
export interface NonWorkDay {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  assigneeName: string | null;
}

export type NewNonWorkDay = Omit<NonWorkDay, 'id'>;

export interface Project {
  id: string;
  name: string;
}

export interface Milestone {
  id: string;
  name: string;
  targetDate: string | null;
  description?: string;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkflowState {
  id: string;
  name: string;
  type: string; // 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'duplicate'
  position: number;
}

/** A Linear user an issue can be assigned to */
export interface AssignableUser {
  id: string;
  name: string;
  displayName: string;
}

/** Handlers that enable editing status, assignee, and title directly from schedule table cells */
export interface InlineEditHandlers {
  loadWorkflowStates: (teamId: string) => Promise<WorkflowState[]>;
  loadAssignableUsers: (teamId: string) => Promise<AssignableUser[]>;
  setStatus: (taskUuid: string, state: WorkflowState) => Promise<void>;
  setAssignee: (taskUuid: string, user: AssignableUser | null) => Promise<void>;
  renameTask: (taskUuid: string, title: string) => Promise<void>;
}

export const PRIORITY_MAP: Record<number, string> = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

export type TimeScale = 'day' | 'week' | 'month';

export interface Filters {
  assignee: string;
  status: string;
  search: string;
  dateFrom: string;
  dateTo: string;
  showCompleted: boolean;
}
