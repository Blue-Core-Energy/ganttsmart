import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // Chainable query builder: every builder method returns the builder; awaiting it yields `result`.
  const builder = {
    result: { data: [] as unknown[], error: null as { message: string } | null },
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn(),
    upsert: vi.fn(),
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(builder.result).then(resolve, reject);
    },
  };
  for (const name of ['select', 'eq', 'order', 'limit', 'insert', 'upsert'] as const) {
    builder[name].mockImplementation(() => builder);
  }
  const from = vi.fn(() => builder);
  const getSession = vi.fn(async () => ({ data: { session: { user: { id: 'user-1' } } } }));
  return { builder, from, getSession };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mocks.from,
    auth: { getSession: mocks.getSession },
  },
}));

import { history } from './history';

describe('supabase history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.builder.result = { data: [], error: null };
  });

  it('addBaselines upserts with the user and project, ignoring duplicates', async () => {
    await history.addBaselines('proj-1', [{ issue_id: 'ENG-1', planned_start: null, planned_due: '2026-11-01' }]);

    expect(mocks.from).toHaveBeenCalledWith('task_baselines');
    expect(mocks.builder.upsert).toHaveBeenCalledWith(
      [{ user_id: 'user-1', issue_id: 'ENG-1', project_id: 'proj-1', planned_start: null, planned_due: '2026-11-01' }],
      { onConflict: 'user_id,issue_id', ignoreDuplicates: true },
    );
  });

  it('addBaselines throws when Supabase returns an error', async () => {
    mocks.builder.result = { data: [], error: { message: 'boom' } };
    await expect(
      history.addBaselines('proj-1', [{ issue_id: 'ENG-1', planned_start: null, planned_due: '2026-11-01' }]),
    ).rejects.toThrow('boom');
  });

  it('getTaskHistory orders by changed_at descending with limit 50', async () => {
    const rows = [
      { issue_id: 'ENG-1', field_changed: 'due_date', old_value: null, new_value: '2026-11-01', changed_at: 'x' },
    ];
    mocks.builder.result = { data: rows, error: null };

    const result = await history.getTaskHistory('ENG-1');

    expect(mocks.from).toHaveBeenCalledWith('issue_change_history');
    expect(mocks.builder.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(mocks.builder.eq).toHaveBeenCalledWith('issue_id', 'ENG-1');
    expect(mocks.builder.order).toHaveBeenCalledWith('changed_at', { ascending: false });
    expect(mocks.builder.limit).toHaveBeenCalledWith(50);
    expect(result).toEqual(rows);
  });
});
