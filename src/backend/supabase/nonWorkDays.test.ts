import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // Chainable query builder: every builder method returns the builder; awaiting it yields `result`.
  const builder = {
    result: { data: null as unknown, error: null as { code?: string; message: string } | null },
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    single: vi.fn(),
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(builder.result).then(resolve, reject);
    },
  };
  for (const name of ['select', 'eq', 'order', 'insert', 'delete', 'single'] as const) {
    builder[name].mockImplementation(() => builder);
  }
  const from = vi.fn(() => builder);
  const getSession = vi.fn(async () => ({
    data: { session: { user: { id: 'user-1' } } as { user: { id: string } } | null },
  }));
  return { builder, from, getSession };
});

vi.mock('@/lib/supabase', () => ({
  supabase: { from: mocks.from, auth: { getSession: mocks.getSession } },
}));

import { nonWorkDays } from './nonWorkDays';

const ROW = {
  id: 'n1',
  label: 'Thanksgiving',
  start_date: '2026-11-26',
  end_date: '2026-11-26',
  assignee_name: null,
};
const ENTRY = { id: 'n1', label: 'Thanksgiving', startDate: '2026-11-26', endDate: '2026-11-26', assigneeName: null };
const MISSING_TABLE = {
  code: 'PGRST205',
  message: "Could not find the table 'public.non_work_days' in the schema cache",
};

describe('supabase nonWorkDays', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.builder.result = { data: [], error: null };
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });
  });

  it('list maps rows to entries for the signed-in user, oldest first', async () => {
    mocks.builder.result = { data: [ROW], error: null };
    await expect(nonWorkDays.list()).resolves.toEqual([ENTRY]);
    expect(mocks.from).toHaveBeenCalledWith('non_work_days');
    expect(mocks.builder.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(mocks.builder.order).toHaveBeenCalledWith('start_date', { ascending: true });
  });

  it('list is empty without a session', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    await expect(nonWorkDays.list()).resolves.toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('list falls back to an empty calendar when the table is not migrated yet', async () => {
    mocks.builder.result = { data: null, error: MISSING_TABLE };
    await expect(nonWorkDays.list()).resolves.toEqual([]);
    mocks.builder.result = { data: null, error: { code: '42P01', message: 'relation "non_work_days" does not exist' } };
    await expect(nonWorkDays.list()).resolves.toEqual([]);
  });

  it('list throws other Supabase errors', async () => {
    mocks.builder.result = { data: null, error: { message: 'permission denied' } };
    await expect(nonWorkDays.list()).rejects.toThrow('permission denied');
  });

  it('add inserts snake_case columns with the user and returns the stored entry', async () => {
    mocks.builder.result = { data: { ...ROW, assignee_name: 'Alex' }, error: null };
    const added = await nonWorkDays.add({
      label: 'Thanksgiving',
      startDate: '2026-11-26',
      endDate: '2026-11-26',
      assigneeName: 'Alex',
    });
    expect(mocks.builder.insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      label: 'Thanksgiving',
      start_date: '2026-11-26',
      end_date: '2026-11-26',
      assignee_name: 'Alex',
    });
    expect(added).toEqual({ ...ENTRY, assigneeName: 'Alex' });
  });

  it('add explains a missing migration and asks for sign-in', async () => {
    const entry = { label: 'x', startDate: '2026-11-26', endDate: '2026-11-26', assigneeName: null };
    mocks.builder.result = { data: null, error: MISSING_TABLE };
    await expect(nonWorkDays.add(entry)).rejects.toThrow(/migration 009/);
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    await expect(nonWorkDays.add(entry)).rejects.toThrow(/Sign in/);
  });

  it('remove deletes by id for the user and throws on errors', async () => {
    await nonWorkDays.remove('n1');
    expect(mocks.builder.delete).toHaveBeenCalled();
    expect(mocks.builder.eq).toHaveBeenCalledWith('id', 'n1');
    expect(mocks.builder.eq).toHaveBeenCalledWith('user_id', 'user-1');

    mocks.builder.result = { data: null, error: { message: 'boom' } };
    await expect(nonWorkDays.remove('n1')).rejects.toThrow('boom');
  });
});
