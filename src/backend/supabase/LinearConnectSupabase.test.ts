// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const invoke = vi.fn();
  const toastError = vi.fn();
  return { invoke, toastError };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: mocks.invoke,
    },
  },
}));

vi.mock('@/components/toastStore', () => ({
  toastError: mocks.toastError,
}));

import { connectLinear } from './LinearConnectSupabase';

describe('LinearConnectSupabase', () => {
  const originalLocationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: 'http://localhost:5173/app', search: '' },
    });
  });

  afterEach(() => {
    if (originalLocationDescriptor) {
      Object.defineProperty(window, 'location', originalLocationDescriptor);
    } else {
      delete (window as { location?: Location }).location;
    }
  });

  it('starts server-bound OAuth flow with PKCE, stores state, and navigates to authorizeUrl', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: {
        authorizeUrl: 'https://linear.app/oauth/authorize?client_id=cid&state=test-state&code_challenge=xyz',
        state: 'test-state-1234',
      },
      error: null,
    });

    await connectLinear();

    expect(mocks.invoke).toHaveBeenCalledWith('linear-oauth-callback', {
      body: {
        action: 'start',
        redirect_uri: import.meta.env.VITE_LINEAR_REDIRECT_URI,
      },
    });
    expect(sessionStorage.getItem('linear_oauth_state')).toBe('test-state-1234');
    expect(window.location.href).toBe(
      'https://linear.app/oauth/authorize?client_id=cid&state=test-state&code_challenge=xyz',
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('surfaces edge function failure and does not navigate or save state', async () => {
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'Unauthorized' },
    });

    await connectLinear();

    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('Unauthorized'));
    expect(sessionStorage.getItem('linear_oauth_state')).toBeNull();
    expect(window.location.href).toBe('http://localhost:5173/app');
  });

  it('preserves project deep-link parameter across connectLinear', async () => {
    window.location.search = '?project=proj-99';
    mocks.invoke.mockResolvedValueOnce({
      data: {
        authorizeUrl: 'https://linear.app/oauth/authorize?client_id=cid&state=s1',
        state: 's1',
      },
      error: null,
    });

    await connectLinear();

    expect(sessionStorage.getItem('linear_oauth_project')).toBe('proj-99');
    expect(sessionStorage.getItem('linear_oauth_state')).toBe('s1');
  });
});
