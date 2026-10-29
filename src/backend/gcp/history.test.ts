import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { history } from './history';

const fetchMock = vi.fn<typeof fetch>();

function ok(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sentBody(call: number): unknown {
  return JSON.parse(fetchMock.mock.calls[call][1]!.body as string);
}

describe('gcp history', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loadBaselines GETs by project and returns the rows', async () => {
    const rows = [{ issue_id: 'ENG-1', planned_start: null, planned_due: '2026-11-01', first_seen_at: 'x' }];
    fetchMock.mockResolvedValue(ok({ baselines: rows }));

    await expect(history.loadBaselines('proj 1&x')).resolves.toEqual(rows);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/history/baselines?projectId=proj+1%26x');
  });

  it('addBaselines POSTs JSON with projectId and snake_case rows', async () => {
    const rows = [{ issue_id: 'ENG-1', planned_start: null, planned_due: '2026-11-01' }];
    await history.addBaselines('proj-1', rows);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/history/baselines');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'manual',
      credentials: 'same-origin',
    });
    expect(sentBody(0)).toEqual({ projectId: 'proj-1', baselines: rows });
  });

  it('addBaselines sends at most 2000 rows per request', async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({
      issue_id: `ENG-${i}`,
      planned_start: null,
      planned_due: '2026-11-01',
    }));
    await history.addBaselines('proj-1', rows);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((sentBody(0) as { baselines: unknown[] }).baselines).toEqual(rows.slice(0, 2000));
    expect((sentBody(1) as { baselines: unknown[] }).baselines).toEqual([rows[2000]]);
  });

  it('addBaselines sends nothing for no rows', async () => {
    await history.addBaselines('proj-1', []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logChange POSTs camelCase fields', async () => {
    await history.logChange('proj-1', 'ENG-1', 'due_date', '2026-11-01', '2026-11-05');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/history/changes');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(sentBody(0)).toEqual({
      projectId: 'proj-1',
      issueId: 'ENG-1',
      field: 'due_date',
      oldValue: '2026-11-01',
      newValue: '2026-11-05',
    });
  });

  it('logStatusTransition POSTs camelCase fields', async () => {
    await history.logStatusTransition('proj-1', 'ENG-1', null, 'Done');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/history/transitions');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(sentBody(0)).toEqual({ projectId: 'proj-1', issueId: 'ENG-1', fromStatus: null, toStatus: 'Done' });
  });

  it('getTaskHistory GETs by issue and returns the changes', async () => {
    const changes = [
      { issue_id: 'ENG-1', field_changed: 'due_date', old_value: null, new_value: 'y', changed_at: 'x' },
    ];
    fetchMock.mockResolvedValue(ok({ changes }));

    await expect(history.getTaskHistory('ENG-1')).resolves.toEqual(changes);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/history/changes?issueId=ENG-1');
  });

  it('throws the server error message on a non-OK response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'projectId is invalid' }), { status: 400 }));

    await expect(history.loadBaselines('bad/id')).rejects.toThrow('projectId is invalid');
  });
});
