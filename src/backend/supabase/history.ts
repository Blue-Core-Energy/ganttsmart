import { supabase } from '@/lib/supabase';
import type { ChangeEvent, HistoryApi, TaskBaseline } from '../types';

/** Get the current user ID from the local session (no network call). */
async function getUserId(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

// Without a signed-in user every call is a no-op, as it was before the backend seam.
export const history: HistoryApi = {
  async loadBaselines(projectId: string): Promise<TaskBaseline[]> {
    const userId = await getUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('task_baselines')
      .select('issue_id, planned_start, planned_due, first_seen_at')
      .eq('user_id', userId)
      .eq('project_id', projectId);

    if (error) throw new Error(error.message);
    return data || [];
  },

  async addBaselines(projectId, rows) {
    const userId = await getUserId();
    if (!userId) return;

    const { error } = await supabase.from('task_baselines').upsert(
      rows.map((r) => ({
        user_id: userId,
        issue_id: r.issue_id,
        project_id: projectId,
        planned_start: r.planned_start,
        planned_due: r.planned_due,
      })),
      { onConflict: 'user_id,issue_id', ignoreDuplicates: true },
    );

    if (error) throw new Error(error.message);
  },

  async logChange(projectId, issueId, field, oldValue, newValue) {
    const userId = await getUserId();
    if (!userId) return;

    const { error } = await supabase.from('issue_change_history').insert({
      user_id: userId,
      issue_id: issueId,
      project_id: projectId,
      field_changed: field,
      old_value: oldValue,
      new_value: newValue,
    });

    if (error) throw new Error(error.message);
  },

  async logStatusTransition(projectId, issueId, fromStatus, toStatus) {
    const userId = await getUserId();
    if (!userId) return;

    const { error } = await supabase.from('status_transition_log').insert({
      user_id: userId,
      issue_id: issueId,
      project_id: projectId,
      from_status: fromStatus,
      to_status: toStatus,
    });

    if (error) throw new Error(error.message);
  },

  async getTaskHistory(issueId: string): Promise<ChangeEvent[]> {
    const userId = await getUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      .from('issue_change_history')
      .select('issue_id, field_changed, old_value, new_value, changed_at')
      .eq('user_id', userId)
      .eq('issue_id', issueId)
      .order('changed_at', { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);
    return data || [];
  },
};
