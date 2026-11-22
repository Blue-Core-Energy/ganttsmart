import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nonWorkDays } from './nonWorkDays';

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ENTRY = { id: 'a1', label: 'Thanksgiving', startDate: '2026-11-26', endDate: '2026-11-26', assigneeName: null };

describe('gcp nonWorkDays', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list GETs the shared calendar', async () => {
    fetchMock.mockResolvedValue(json({ nonWorkDays: [ENTRY] }));
    await expect(nonWorkDays.list()).resolves.toEqual([ENTRY]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/non-work-days');
  });

  it('add POSTs the entry and returns the stored one', async () => {
    fetchMock.mockResolvedValue(json({ nonWorkDay: ENTRY }, 201));
    const { id: _id, ...input } = ENTRY;
    await expect(nonWorkDays.add(input)).resolves.toEqual(ENTRY);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/non-work-days');
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(init!.body as string)).toEqual(input);
  });

  it('add surfaces the server’s validation message', async () => {
    fetchMock.mockResolvedValue(json({ error: 'label must be 1 to 200 characters' }, 400));
    const { id: _id, ...input } = ENTRY;
    await expect(nonWorkDays.add(input)).rejects.toThrow('label must be 1 to 200 characters');
  });

  it('remove DELETEs by encoded id and throws on failure', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await nonWorkDays.remove('a/1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/non-work-days/a%2F1');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });

    fetchMock.mockResolvedValue(json({ error: 'not found' }, 404));
    await expect(nonWorkDays.remove('gone')).rejects.toThrow('not found');
  });
});
