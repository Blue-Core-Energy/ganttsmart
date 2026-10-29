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

export interface Backend {
  kind: 'supabase' | 'gcp';
  capabilities: { sharing: boolean; passwordLogin: boolean; marketingPages: boolean };
  useAuth(): AuthState;
  linearRequest(token: string, body: { query: string; variables?: Record<string, unknown> }): Promise<Response>;
  history: HistoryApi;
}
