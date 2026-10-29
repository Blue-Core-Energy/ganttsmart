/** A user's Linear OAuth tokens. */
export interface LinearTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds, or null when Linear did not say. */
  expiresAt: number | null;
}

// History types are snake_case to match the frontend's existing types.

export interface BaselineRow {
  issue_id: string;
  planned_start: string | null;
  planned_due: string;
}

export interface Baseline extends BaselineRow {
  /** ISO 8601 timestamp. */
  first_seen_at: string;
}

export interface ChangeInput {
  projectId: string;
  issueId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface ChangeEvent {
  issue_id: string;
  field_changed: string;
  old_value: string | null;
  new_value: string | null;
  /** ISO 8601 timestamp. */
  changed_at: string;
}

export interface TransitionInput {
  projectId: string;
  issueId: string;
  fromStatus: string | null;
  toStatus: string;
}

/** Per-user persistence for Linear tokens and planning history. `sub` is the user's stable identity. */
export interface Store {
  getTokens(sub: string): Promise<LinearTokens | null>;
  saveTokens(sub: string, email: string, tokens: LinearTokens): Promise<void>;
  clearTokens(sub: string): Promise<void>;
  /**
   * Atomically replaces the stored tokens with `next` if the stored refresh token equals
   * `expectedRefreshToken`, and returns `next`. Otherwise another request already renewed them, so
   * the stored tokens are returned untouched. If nothing is stored (the user disconnected
   * meanwhile), returns `next` without writing.
   */
  swapTokens(sub: string, expectedRefreshToken: string, next: LinearTokens): Promise<LinearTokens>;
  listBaselines(sub: string, projectId: string): Promise<Baseline[]>;
  /** Inserts rows not yet stored. Existing rows keep their original values and `first_seen_at`. */
  addBaselinesIfAbsent(sub: string, projectId: string, rows: BaselineRow[]): Promise<void>;
  addChange(sub: string, change: ChangeInput): Promise<void>;
  /** The issue's changes, newest first, at most `limit`. */
  listChanges(sub: string, issueId: string, limit: number): Promise<ChangeEvent[]>;
  addTransition(sub: string, t: TransitionInput): Promise<void>;
}
