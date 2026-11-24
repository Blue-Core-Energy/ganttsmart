import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, deleteRequest, onSessionExpired, postJson, SessionExpiredError } from './api';

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

  it('rethrows a network TypeError unchanged without notifying session-expiry listeners', async () => {
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    const networkError = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(networkError);

    // Unchanged, so gql's TypeError network retry still fires (including Safari's "Load failed")
    await expect(apiFetch('/api/me')).rejects.toBe(networkError);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('notifies session-expiry listeners for an opaque redirect and a non-reconnect 401', async () => {
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    const redirect = new Response(null, { status: 200 });
    Object.defineProperty(redirect, 'type', { value: 'opaqueredirect' });
    fetchMock.mockResolvedValueOnce(redirect).mockResolvedValueOnce(json(401, { error: 'unauthorized' }));

    await expect(apiFetch('/api/me')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(apiFetch('/api/me')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('does not notify session-expiry listeners for a reconnect 401', async () => {
    const listener = vi.fn();
    const unsubscribe = onSessionExpired(listener);
    fetchMock.mockResolvedValue(
      json(401, { error: 'Linear authentication expired. Please reconnect.', reconnect: true }),
    );

    await apiFetch('/api/linear/graphql', { method: 'POST', body: '{}' });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
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

describe('deleteRequest', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends DELETE and drains the response body on 2xx', async () => {
    const res = json(200, { ok: true });
    const textSpy = vi.spyOn(res, 'text');
    fetchMock.mockResolvedValue(res);

    await expect(deleteRequest('/api/history/baselines/1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/history/baselines/1', {
      method: 'DELETE',
      redirect: 'manual',
      credentials: 'same-origin',
    });
    expect(textSpy).toHaveBeenCalledTimes(1);
  });

  it('tolerates response text drain rejection on 2xx without throwing', async () => {
    const res = new Response(null, { status: 204 });
    vi.spyOn(res, 'text').mockRejectedValue(new Error('stream closed'));
    fetchMock.mockResolvedValue(res);

    await expect(deleteRequest('/api/history/baselines/1')).resolves.toBeUndefined();
  });

  it('throws on non-2xx responses with error message from json body', async () => {
    fetchMock.mockResolvedValue(json(500, { error: 'delete failed' }));

    await expect(deleteRequest('/api/history/baselines/1')).rejects.toThrow('delete failed');
  });

  it('throws fallback status message on non-2xx responses without json body', async () => {
    fetchMock.mockResolvedValue(new Response('Server Error', { status: 502 }));

    await expect(deleteRequest('/api/history/baselines/1')).rejects.toThrow('Request failed (HTTP 502)');
  });
});

describe('postJson', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends POST with serialized json body and drains response on 2xx', async () => {
    const res = json(200, { ok: true });
    const textSpy = vi.spyOn(res, 'text');
    fetchMock.mockResolvedValue(res);

    await expect(postJson('/api/history/baselines', { name: 'v1' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/history/baselines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'v1' }),
      redirect: 'manual',
      credentials: 'same-origin',
    });
    expect(textSpy).toHaveBeenCalledTimes(1);
  });

  it('sends POST without body when body is undefined and drains response on 2xx', async () => {
    const res = json(200, { ok: true });
    const textSpy = vi.spyOn(res, 'text');
    fetchMock.mockResolvedValue(res);

    await expect(postJson('/api/linear/sync')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/linear/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: undefined,
      redirect: 'manual',
      credentials: 'same-origin',
    });
    expect(textSpy).toHaveBeenCalledTimes(1);
  });

  it('tolerates response text drain rejection on 2xx without throwing', async () => {
    const res = json(201, { id: '1' });
    vi.spyOn(res, 'text').mockRejectedValue(new Error('stream aborted'));
    fetchMock.mockResolvedValue(res);

    await expect(postJson('/api/history/baselines', { name: 'v1' })).resolves.toBeUndefined();
  });

  it('throws on non-2xx responses with error message from json body', async () => {
    fetchMock.mockResolvedValue(json(400, { error: 'invalid payload' }));

    await expect(postJson('/api/history/baselines', { bad: true })).rejects.toThrow('invalid payload');
  });

  it('throws fallback status message on non-2xx responses without json body', async () => {
    fetchMock.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    await expect(postJson('/api/history/baselines')).rejects.toThrow('Request failed (HTTP 502)');
  });
});
