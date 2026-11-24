// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const getSession = vi.fn();
  const onAuthStateChange = vi.fn();
  const refreshSession = vi.fn();
  const signOut = vi.fn();
  const invoke = vi.fn();
  const toastError = vi.fn();

  const builder = {
    result: { data: null as unknown, error: null as unknown },
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
    update: vi.fn(),
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(builder.result).then(resolve, reject);
    },
  };
  for (const name of ['select', 'eq', 'single', 'update'] as const) {
    builder[name].mockImplementation(() => builder);
  }
  const from = vi.fn(() => builder);

  return { getSession, onAuthStateChange, refreshSession, signOut, invoke, toastError, from, builder };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
      refreshSession: mocks.refreshSession,
      signOut: mocks.signOut,
    },
    functions: {
      invoke: mocks.invoke,
    },
    from: mocks.from,
  },
}));

vi.mock('@/components/toastStore', () => ({
  toastError: mocks.toastError,
}));

import { useSupabaseAuth } from './useSupabaseAuth';

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

describe('useSupabaseAuth', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          user: { id: 'user-abc', email: 'alice@example.com' },
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    });
    mocks.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    });
    mocks.builder.result = {
      data: { linear_access_token: 'lin_at_123', linear_token_expires_at: null },
      error: null,
    };
  });

  afterEach(async () => {
    for (const unmount of Array.from(cleanups)) {
      await unmount();
    }
    cleanups.clear();
    vi.unstubAllGlobals();
  });

  it('loads user and linearToken on initial mount', async () => {
    const { result, unmount } = await renderHook(() => useSupabaseAuth());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.user).toEqual({ id: 'user-abc', email: 'alice@example.com' });
    expect(result.current.linearToken).toBe('lin_at_123');

    await unmount();
  });

  it('disconnectLinear invokes edge function and clears linearToken on success', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: { success: true },
      error: null,
    });

    const { result, unmount } = await renderHook(() => useSupabaseAuth());
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.disconnectLinear();
    });

    expect(mocks.invoke).toHaveBeenCalledWith('linear-token-refresh', {
      body: { action: 'disconnect' },
    });
    expect(result.current.linearToken).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();

    await unmount();
  });

  it('disconnectLinear does NOT silently wipe linear_access_token client-side on edge function failure', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: { error: 'Network failure' },
      error: { message: 'Network failure' },
    });

    const { result, unmount } = await renderHook(() => useSupabaseAuth());
    await act(async () => {
      await Promise.resolve();
    });

    mocks.builder.update.mockClear();

    await act(async () => {
      await result.current.disconnectLinear();
    });

    // Must NOT have wiped user_settings client-side leaving server refresh token active
    expect(mocks.builder.update).not.toHaveBeenCalled();
    // Must have surfaced the error via toast rather than an unhandled rejection
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('Network failure'));
    // Token in state is NOT cleared on failure
    expect(result.current.linearToken).toBe('lin_at_123');

    await unmount();
  });
});
