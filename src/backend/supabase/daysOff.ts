import { supabase } from '@/lib/supabase';
import type { DayOff } from '@/types';
import type { DaysOffApi } from '../types';

const COLUMNS = 'id, label, start_date, end_date, assignee_name';

interface Row {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  assignee_name: string | null;
}

const toEntry = (r: Row): DayOff => ({
  id: r.id,
  label: r.label,
  startDate: r.start_date,
  endDate: r.end_date,
  assigneeName: r.assignee_name,
});

/** PostgREST (PGRST205) or Postgres (42P01) saying the table is not there: migration 009 has not run. */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return (
    error.code === 'PGRST205' ||
    error.code === '42P01' ||
    /could not find the table|relation .* does not exist/i.test(error.message ?? '')
  );
}

const NOT_MIGRATED = 'Days Off is not set up on this Supabase project yet (apply migration 009).';

async function getUserId(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

// The table is still `non_work_days`, the feature's original name. It is kept on purpose: the name is
// invisible to users, and renaming it would need a migration that also copes with projects where 009
// was never applied, plus a coordinated deploy of the migration and this code.
// Each Supabase account keeps its own calendar. Until the table exists the calendar reads as empty,
// so the chart keeps working; adding an entry then fails with a message saying why.
export const daysOff: DaysOffApi = {
  async list() {
    const userId = await getUserId();
    if (!userId) return [];

    const { data, error } = await supabase
      // Original table name, see the note above `daysOff`
      .from('non_work_days')
      .select(COLUMNS)
      .eq('user_id', userId)
      .order('start_date', { ascending: true });

    if (error) {
      if (isMissingTable(error)) return [];
      throw new Error(error.message);
    }
    return ((data as Row[] | null) ?? []).map(toEntry);
  },

  async add(entry) {
    const userId = await getUserId();
    if (!userId) throw new Error('Sign in to save days off.');

    const { data, error } = await supabase
      // Original table name, see the note above `daysOff`
      .from('non_work_days')
      .insert({
        user_id: userId,
        label: entry.label,
        start_date: entry.startDate,
        end_date: entry.endDate,
        assignee_name: entry.assigneeName,
      })
      .select(COLUMNS)
      .single();

    if (error) throw new Error(isMissingTable(error) ? NOT_MIGRATED : error.message);
    return toEntry(data as Row);
  },

  async remove(id) {
    const userId = await getUserId();
    if (!userId) return;

    // Original table name, see the note above `daysOff`
    const { error } = await supabase.from('non_work_days').delete().eq('id', id).eq('user_id', userId);
    if (error) throw new Error(isMissingTable(error) ? NOT_MIGRATED : error.message);
  },
};
