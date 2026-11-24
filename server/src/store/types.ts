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

/** A company closure or one person's time off, shared by the whole team. Without `assigneeName` it is company-wide. */
export interface DayOff {
  id: string;
  label: string;
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string;
  /** `YYYY-MM-DD`, inclusive; equal to `startDate` for a single day. */
  endDate: string;
  assigneeName: string | null;
}

export type DayOffInput = Omit<DayOff, 'id'>;

export interface ClearTokensExpected {
  refreshToken?: string | null;
  accessToken?: string;
}

/**
 * Persistence for Linear tokens and planning history (per user; `sub` is the user's stable identity)
 * and the days off calendar (shared by everyone).
 */
export interface Store {
  getTokens(sub: string): Promise<LinearTokens | null>;
  saveTokens(sub: string, email: string, tokens: LinearTokens): Promise<void>;
  /**
   * Clears stored tokens. If `expected` is provided:
   * - as a string or null: clears only if the stored refresh token matches it.
   * - as an object: clears only if the specified refreshToken and/or accessToken match the stored tokens.
   * If omitted (undefined), clears unconditionally and returns true.
   * Returns true if cleared, false if the stored tokens did not match.
   */
  clearTokens(sub: string, expected?: string | null | ClearTokensExpected): Promise<boolean>;
  /**
   * Atomically replaces the stored tokens with `next` if the stored refresh token equals
   * `expectedRefreshToken`, and returns `next`. Otherwise another request already renewed them, so
   * the stored tokens are returned untouched. If nothing is stored (the user disconnected
   * meanwhile), returns null without writing.
   */
  swapTokens(sub: string, expectedRefreshToken: string, next: LinearTokens): Promise<LinearTokens | null>;
  listBaselines(sub: string, projectId: string): Promise<Baseline[]>;
  /** Inserts rows not yet stored. Existing rows keep their original values and `first_seen_at`. */
  addBaselinesIfAbsent(sub: string, projectId: string, rows: BaselineRow[]): Promise<void>;
  addChange(sub: string, change: ChangeInput): Promise<void>;
  /** The issue's changes, newest first, at most `limit`. */
  listChanges(sub: string, issueId: string, limit: number): Promise<ChangeEvent[]>;
  addTransition(sub: string, t: TransitionInput): Promise<void>;
  /** The shared calendar, sorted by start date, then end date, then label. */
  listDaysOff(): Promise<DayOff[]>;
  /** Adds an entry to the shared calendar; `sub` is recorded as its author. */
  addDayOff(sub: string, input: DayOffInput): Promise<DayOff>;
  /** Removes an entry. Returns false if there was none with that id. */
  deleteDayOff(id: string): Promise<boolean>;
}
