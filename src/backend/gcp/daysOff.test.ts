import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daysOff } from './daysOff';

const fetchMock = vi.fn<typeof fetch>();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ENTRY = { id: 'a1', label: 'Thanksgiving', startDate: '2026-11-26', endDate: '2026-11-26', assigneeName: null };

describe('gcp daysOff', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list GETs the shared calendar', async () => {
    fetchMock.mockResolvedValue(json({ daysOff: [ENTRY] }));
    await expect(daysOff.list()).resolves.toEqual([ENTRY]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/days-off');
  });

  it('add POSTs the entry and returns the stored one', async () => {
    fetchMock.mockResolvedValue(json({ dayOff: ENTRY }, 201));
    const { id: _id, ...input } = ENTRY;
    await expect(daysOff.add(input)).resolves.toEqual(ENTRY);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/days-off');
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(init!.body as string)).toEqual(input);
  });

  it('add surfaces the server’s validation message', async () => {
    fetchMock.mockResolvedValue(json({ error: 'label must be 1 to 200 characters' }, 400));
    const { id: _id, ...input } = ENTRY;
    await expect(daysOff.add(input)).rejects.toThrow('label must be 1 to 200 characters');
  });

  it('remove DELETEs by encoded id and throws on failure', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }));
    await daysOff.remove('a/1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/days-off/a%2F1');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });

    fetchMock.mockResolvedValue(json({ error: 'not found' }, 404));
    await expect(daysOff.remove('gone')).rejects.toThrow('not found');
  });
});
