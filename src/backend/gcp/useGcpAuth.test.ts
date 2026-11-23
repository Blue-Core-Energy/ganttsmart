// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';
import { UNREACHABLE_MESSAGE } from './sessionError';
import { useGcpAuth } from './useGcpAuth';

const fetchMock = vi.fn<typeof fetch>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface HookResult<T> {
  current: T;
}

const cleanups = new Set<() => Promise<void>>();

async function renderHook<T>(hook: () => T): Promise<{ result: HookResult<T>; unmount: () => Promise<void> }> {
  const result: HookResult<T> = { current: undefined as unknown as T };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Component() {
    result.current = hook();
    return null;
  }

  await act(async () => {
    root.render(createElement(Component));
  });

  const unmount = async () => {
    if (!cleanups.has(unmount)) return;
    cleanups.delete(unmount);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };

  cleanups.add(unmount);

  return { result, unmount };
}

describe('useGcpAuth', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    for (const unmount of Array.from(cleanups)) {
      await unmount();
    }
    cleanups.clear();
    vi.unstubAllGlobals();
  });

  it('loads user and clears user when session-expired event fires mid-use', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { email: 'alice@example.com', linearConnected: true }));

    const { result, unmount } = await renderHook(() => useGcpAuth());

    // Flush initial /api/me load
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.user).toEqual({ id: 'alice@example.com', email: 'alice@example.com' });
    expect(result.current.linearToken).toBe('server');
    expect(result.current.signedOutMessage).toBeNull();

    // Mid-use: an API request returns a 401 unauthorized (session expired)
    fetchMock.mockResolvedValueOnce(json(401, { error: 'session expired' }));

    await act(async () => {
      await expect(apiFetch('/api/history/changes?issueId=ISS-1')).rejects.toThrow();
    });

    // The session-expired listener must have fired and cleared user and linearToken
    expect(result.current.user).toBeNull();
    expect(result.current.linearToken).toBeNull();
    expect(result.current.signedOutMessage).toBeNull();

    await unmount();
  });

  it('handles mid-use session expiry caused by an opaque redirect', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { email: 'bob@example.com', linearConnected: false }));

    const { result, unmount } = await renderHook(() => useGcpAuth());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.user).toEqual({ id: 'bob@example.com', email: 'bob@example.com' });

    // Mid-use: IAP responds with opaque redirect (redirect: manual)
    const redirectRes = new Response(null, { status: 200 });
    Object.defineProperty(redirectRes, 'type', { value: 'opaqueredirect' });
    fetchMock.mockResolvedValueOnce(redirectRes);

    await act(async () => {
      await expect(apiFetch('/api/history/baselines')).rejects.toThrow();
    });

    expect(result.current.user).toBeNull();
    expect(result.current.signedOutMessage).toBeNull();

    await unmount();
  });

  it('sets unreachable message on initial load network failure (TypeError)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const { result, unmount } = await renderHook(() => useGcpAuth());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.signedOutMessage).toBe(UNREACHABLE_MESSAGE);

    await unmount();
  });

  it('sets unreachable message on initial load server 5xx failure', async () => {
    fetchMock.mockResolvedValueOnce(json(500, { error: 'internal error' }));

    const { result, unmount } = await renderHook(() => useGcpAuth());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.signedOutMessage).toBe(UNREACHABLE_MESSAGE);

    await unmount();
  });

  it('leaves signedOutMessage null on initial load session expiry (401)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: 'unauthorized' }));

    const { result, unmount } = await renderHook(() => useGcpAuth());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.signedOutMessage).toBeNull();

    await unmount();
  });
});
