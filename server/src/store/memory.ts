import type { Baseline, BaselineRow, ChangeEvent, LinearTokens, Store, TransitionInput } from './types.js';

interface UserData {
  email: string | null;
  linear: LinearTokens | null;
  /** Keyed by issue id, mirroring users/{sub}/baselines/{issueId}. */
  baselines: Map<string, Baseline & { projectId: string }>;
  /** In insertion order; `seq` breaks ties between changes recorded in the same millisecond. */
  changes: (ChangeEvent & { projectId: string; seq: number })[];
  transitions: (TransitionInput & { transitionedAt: string })[];
}

/** In-memory Store for local development and tests. Data is lost on restart. */
export function createMemoryStore(): Store {
  const users = new Map<string, UserData>();
  let seq = 0;

  function user(sub: string): UserData {
    let data = users.get(sub);
    if (!data) {
      data = { email: null, linear: null, baselines: new Map(), changes: [], transitions: [] };
      users.set(sub, data);
    }
    return data;
  }

  // Copies keep callers from mutating stored state.
  const copy = (tokens: LinearTokens): LinearTokens => ({ ...tokens });

  return {
    async getTokens(sub) {
      const linear = users.get(sub)?.linear;
      return linear ? copy(linear) : null;
    },

    async saveTokens(sub, email, tokens) {
      const data = user(sub);
      data.email = email;
      data.linear = copy(tokens);
    },

    async clearTokens(sub) {
      const data = users.get(sub);
      if (data) data.linear = null;
    },

    // Single-threaded JS: no await between read and write, so this is atomic.
    async swapTokens(sub, expectedRefreshToken, next) {
      const data = users.get(sub);
      const stored = data?.linear ?? null;
      if (!data || stored === null) return copy(next);
      if (stored.refreshToken !== expectedRefreshToken) return copy(stored);
      data.linear = copy(next);
      return copy(next);
    },

    async listBaselines(sub, projectId) {
      const data = users.get(sub);
      if (!data) return [];
      return [...data.baselines.values()]
        .filter((b) => b.projectId === projectId)
        .map(({ issue_id, planned_start, planned_due, first_seen_at }) => ({
          issue_id,
          planned_start,
          planned_due,
          first_seen_at,
        }));
    },

    async addBaselinesIfAbsent(sub, projectId, rows: BaselineRow[]) {
      if (rows.length === 0) return;
      const data = user(sub);
      const now = new Date().toISOString();
      for (const row of rows) {
        if (data.baselines.has(row.issue_id)) continue;
        data.baselines.set(row.issue_id, {
          issue_id: row.issue_id,
          planned_start: row.planned_start,
          planned_due: row.planned_due,
          first_seen_at: now,
          projectId,
        });
      }
    },

    async addChange(sub, change) {
      user(sub).changes.push({
        issue_id: change.issueId,
        field_changed: change.field,
        old_value: change.oldValue,
        new_value: change.newValue,
        changed_at: new Date().toISOString(),
        projectId: change.projectId,
        seq: ++seq,
      });
    },

    async listChanges(sub, issueId, limit) {
      const data = users.get(sub);
      if (!data) return [];
      return data.changes
        .filter((c) => c.issue_id === issueId)
        .sort((a, b) => b.changed_at.localeCompare(a.changed_at) || b.seq - a.seq)
        .slice(0, Math.max(0, limit))
        .map(({ issue_id, field_changed, old_value, new_value, changed_at }) => ({
          issue_id,
          field_changed,
          old_value,
          new_value,
          changed_at,
        }));
    },

    async addTransition(sub, t) {
      user(sub).transitions.push({ ...t, transitionedAt: new Date().toISOString() });
    },
  };
}
