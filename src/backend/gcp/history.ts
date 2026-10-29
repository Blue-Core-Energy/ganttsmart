import type { ChangeEvent, HistoryApi, TaskBaseline } from '../types';
import { getJson, postJson } from './api';

/** The server rejects larger requests (server/src/routes/history.ts MAX_BASELINE_ROWS). */
const MAX_BASELINES_PER_REQUEST = 2000;

// The server scopes every call to the IAP user; the browser never sends a user id.
export const history: HistoryApi = {
  async loadBaselines(projectId) {
    const { baselines } = await getJson<{ baselines: TaskBaseline[] }>(
      `/api/history/baselines?${new URLSearchParams({ projectId })}`,
    );
    return baselines;
  },

  async addBaselines(projectId, rows) {
    for (let i = 0; i < rows.length; i += MAX_BASELINES_PER_REQUEST) {
      const baselines = rows.slice(i, i + MAX_BASELINES_PER_REQUEST).map((r) => ({
        issue_id: r.issue_id,
        planned_start: r.planned_start,
        planned_due: r.planned_due,
      }));
      await postJson('/api/history/baselines', { projectId, baselines });
    }
  },

  async logChange(projectId, issueId, field, oldValue, newValue) {
    await postJson('/api/history/changes', { projectId, issueId, field, oldValue, newValue });
  },

  async logStatusTransition(projectId, issueId, fromStatus, toStatus) {
    await postJson('/api/history/transitions', { projectId, issueId, fromStatus, toStatus });
  },

  async getTaskHistory(issueId) {
    const { changes } = await getJson<{ changes: ChangeEvent[] }>(
      `/api/history/changes?${new URLSearchParams({ issueId })}`,
    );
    return changes;
  },
};
