// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const invoke = vi.fn();
  const refreshSession = vi.fn();
  const navigate = vi.fn();
  return { invoke, refreshSession, navigate };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      refreshSession: mocks.refreshSession,
    },
    functions: {
      invoke: mocks.invoke,
    },
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

import Callback from './Callback';

describe('Callback', () => {
  let container: HTMLDivElement;

  let activeRoot: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    mocks.refreshSession.mockResolvedValue({ data: { session: {} }, error: null });
    mocks.invoke.mockResolvedValue({ data: { success: true }, error: null });
  });

  afterEach(async () => {
    if (activeRoot) {
      await act(async () => {
        activeRoot?.unmount();
      });
      activeRoot = null;
    }
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderCallback(initialEntry: string) {
    activeRoot = createRoot(container);
    await act(async () => {
      activeRoot?.render(createElement(MemoryRouter, { initialEntries: [initialEntry] }, createElement(Callback)));
    });
    return activeRoot;
  }

  it('rejects when code is missing', async () => {
    sessionStorage.setItem('linear_oauth_state', 'valid-state');
    await renderCallback('/callback?state=valid-state');

    expect(container.textContent).toContain('No authorization code received from Linear.');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('rejects when savedState is null even if query state is empty or absent', async () => {
    await renderCallback('/callback?code=abc123');

    expect(container.textContent).toContain('Invalid state parameter. Please try connecting again.');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('rejects when state query does not match savedState', async () => {
    sessionStorage.setItem('linear_oauth_state', 'server-state-1');
    await renderCallback('/callback?code=abc123&state=attacker-state');

    expect(container.textContent).toContain('Invalid state parameter. Please try connecting again.');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('exchanges code when state matches savedState, clears savedState, and navigates', async () => {
    sessionStorage.setItem('linear_oauth_state', 'server-state-match');
    await renderCallback('/callback?code=code-123&state=server-state-match');

    expect(sessionStorage.getItem('linear_oauth_state')).toBeNull();
    expect(mocks.refreshSession).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('linear-oauth-callback', {
      body: {
        action: 'exchange',
        code: 'code-123',
        state: 'server-state-match',
        redirect_uri: import.meta.env.VITE_LINEAR_REDIRECT_URI,
      },
    });
  });

  it('surfaces edge function error when code exchange fails', async () => {
    sessionStorage.setItem('linear_oauth_state', 'server-state-match');
    mocks.invoke.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invalid or expired state parameter' },
    });

    await renderCallback('/callback?code=code-123&state=server-state-match');

    expect(container.textContent).toContain('Connection Failed');
    expect(container.textContent).toContain('Invalid or expired state parameter');
  });
});
