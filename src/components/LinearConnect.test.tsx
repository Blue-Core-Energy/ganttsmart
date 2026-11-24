// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LinearConnect from './LinearConnect';

vi.mock('@/backend', () => ({
  backend: { kind: 'gcp', capabilities: { sharing: false, signOut: true } },
}));

describe('LinearConnect', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders "Sign out of GanttSmart", omits Google note, and triggers onSignOut when clicked', async () => {
    const onConnect = vi.fn();
    const onSignOut = vi.fn();

    await act(async () => {
      root!.render(<LinearConnect userEmail="user@example.com" onConnect={onConnect} onSignOut={onSignOut} />);
    });

    expect(container!.textContent).toContain('user@example.com');
    expect(container!.textContent).toContain('Connect to Linear');

    const signOutBtn = Array.from(container!.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Sign out of GanttSmart',
    );
    expect(signOutBtn).toBeDefined();

    // Verify old note is absent
    expect(container!.textContent).not.toContain('Signs out of GanttSmart only, not Google.');

    // Clicking Sign out of GanttSmart calls onSignOut
    await act(async () => {
      signOutBtn!.click();
    });
    expect(onSignOut).toHaveBeenCalledTimes(1);

    // Clicking Connect Linear Account calls onConnect
    const connectBtn = Array.from(container!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Connect Linear Account'),
    );
    expect(connectBtn).toBeDefined();
    await act(async () => {
      connectBtn!.click();
    });
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('renders error message when error prop is provided', async () => {
    await act(async () => {
      root!.render(
        <LinearConnect
          userEmail="user@example.com"
          error="Failed to connect Linear account"
          onConnect={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );
    });

    const errorAlert = container!.querySelector('[role="alert"]');
    expect(errorAlert).not.toBeNull();
    expect(errorAlert!.textContent).toBe('Failed to connect Linear account');
  });
});
