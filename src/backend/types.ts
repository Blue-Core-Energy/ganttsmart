import type { NewDayOff, DayOff } from '@/types';

export interface TaskBaseline {
  issue_id: string;
  planned_start: string | null;
  planned_due: string;
  first_seen_at: string;
}

export interface ChangeEvent {
  issue_id: string;
  field_changed: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
}

export interface AuthState {
  user: { id: string; email: string } | null;
  loading: boolean;
  /** Opaque to callers; in GCP mode it is the literal 'server' when connected. */
  linearToken: string | null;
  linearError: string | null;
  /** Without a user and password login: why, if not an expired session (null = the default message). */
  signedOutMessage?: string | null;
  connectLinear(): void;
  refreshLinearToken(): Promise<string | null>;
  disconnectLinear(): Promise<void>;
  signOut(): Promise<void>;
  /** Present only when capabilities.passwordLogin. */
  signIn?: (email: string, password: string) => Promise<void>;
  /** Present only when capabilities.passwordLogin. */
  signUp?: (email: string, password: string) => Promise<void>;
  /** Present only when capabilities.passwordLogin. */
  signInWithGoogle?: () => Promise<void>;
  /** Present only when capabilities.keycloakLogin. */
  signInWithKeycloak?: () => Promise<void>;
}

/** All methods throw on failure. */
export interface HistoryApi {
  loadBaselines(projectId: string): Promise<TaskBaseline[]>;
  addBaselines(
    projectId: string,
    rows: Array<{ issue_id: string; planned_start: string | null; planned_due: string }>,
  ): Promise<void>;
  logChange(
    projectId: string,
    issueId: string,
    field: string,
    oldValue: string | null,
    newValue: string | null,
  ): Promise<void>;
  logStatusTransition(projectId: string, issueId: string, fromStatus: string | null, toStatus: string): Promise<void>;
  getTaskHistory(issueId: string): Promise<ChangeEvent[]>;
}

/**
 * The calendar of days off: company closures and one person's time off. All methods throw on failure.
 * Entries are stored on the backend. Whether teammates see the same calendar depends on the backend:
 * see `capabilities.sharedDaysOff`.
 */
export interface DaysOffApi {
  list(): Promise<DayOff[]>;
  add(entry: NewDayOff): Promise<DayOff>;
  remove(id: string): Promise<void>;
}

export interface Backend {
  kind: 'supabase' | 'gcp';
  capabilities: {
    sharing: boolean;
    passwordLogin: boolean;
    marketingPages: boolean;
    /** Whether the days off calendar is one team-wide calendar (true) or one per signed-in account (false). */
    sharedDaysOff: boolean;
    /** Whether the UI offers "Sign out". Absent means true. */
    signOut?: boolean;
    /** Whether sign-in uses Keycloak-only SSO (VITE_AUTH_MODE=keycloak on Supabase). */
    keycloakLogin?: boolean;
  };
  useAuth(): AuthState;
  linearRequest(token: string, body: { query: string; variables?: Record<string, unknown> }): Promise<Response>;
  history: HistoryApi;
  daysOff: DaysOffApi;
}
