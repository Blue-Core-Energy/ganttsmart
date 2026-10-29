import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, onSessionExpired, SessionExpiredError } from './api';

const fetchMock = vi.fn<typeof fetch>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('apiFetch', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws SessionExpiredError for an opaque redirect (IAP sending the user to sign in)', async () => {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
    Object.defineProperty(res, 'status', { value: 0 });
    fetchMock.mockResolvedValue(res);

    await expect(apiFetch('/api/me')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('throws SessionExpiredError for a 401 without reconnect', async () => {
    fetchMock.mockResolvedValue(json(401, { error: 'unauthorized' }));

    await expect(apiFetch('/api/me')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('throws SessionExpiredError for a 401 whose body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    await expect(apiFetch('/api/me')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('returns a 401 with reconnect:true unchanged, body still readable', async () => {
    const body = { error: 'Linear authentication expired. Please reconnect.', reconnect: true };
    fetchMock.mockResolvedValue(json(401, body));

    const res = await apiFetch('/api/linear/graphql', { method: 'POST', body: '{}' });

    // gql() treats any 401 from linearRequest as "Linear authentication expired"
    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
    expect(await res.json()).toEqual(body);
  });

  it('throws SessionExpiredError when fetch rejects with a TypeError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiFetch('/api/me')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('rethrows other fetch rejections unchanged', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    fetchMock.mockRejectedValue(abort);

    await expect(apiFetch('/api/me')).rejects.toBe(abort);
  });

  it('returns a 200 response unchanged', async () => {
    const res = json(200, { email: 'a@b.c', linearConnected: true });
    fetchMock.mockResolvedValue(res);

    await expect(apiFetch('/api/me')).resolves.toBe(res);
  });

  it('returns other error statuses unchanged', async () => {
    const res = json(500, { error: 'internal error' });
    fetchMock.mockResolvedValue(res);

    await expect(apiFetch('/api/me')).resolves.toBe(res);
  });

  it('always sends same-origin credentials and redirect: manual, keeping the rest of init', async () => {
    fetchMock.mockResolvedValue(json(200, {}));

    await apiFetch('/api/linear/disconnect', { method: 'POST', redirect: 'follow', credentials: 'include' });

    expect(fetchMock).toHaveBeenCalledWith('/api/linear/disconnect', {
      method: 'POST',
      redirect: 'manual',
      credentials: 'same-origin',
    });
  });

  it('notifies session-expiry listeners before throwing', async () => {
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    fetchMock.mockResolvedValue(json(401, { error: 'unauthorized' }));

    await expect(apiFetch('/api/me')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await expect(apiFetch('/api/me')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
