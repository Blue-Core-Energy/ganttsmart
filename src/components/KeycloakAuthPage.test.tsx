// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KeycloakAuthPage from './KeycloakAuthPage';

describe('KeycloakAuthPage', () => {
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

  it('renders initial state with heading and continue button', async () => {
    const onSignIn = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      root!.render(<KeycloakAuthPage onSignIn={onSignIn} />);
    });

    expect(container!.textContent).toContain('GanttSmart');
    expect(container!.textContent).toContain('Sign in to your account.');
    const button = container!.querySelector('button');
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain('Continue with Keycloak');
    expect(button!.getAttribute('aria-busy')).toBe('false');
    expect(button!.disabled).toBe(false);
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it('sets aria-busy and updates text while sign-in is in flight, calling onSignIn', async () => {
    let resolveSignIn: () => void = () => {};
    const pendingPromise = new Promise<void>((resolve) => {
      resolveSignIn = resolve;
    });
    const onSignIn = vi.fn().mockReturnValue(pendingPromise);

    await act(async () => {
      root!.render(<KeycloakAuthPage onSignIn={onSignIn} />);
    });

    const button = container!.querySelector('button')!;

    await act(async () => {
      button.click();
    });

    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Redirecting to Keycloak...');

    await act(async () => {
      resolveSignIn();
    });
  });

  it('displays role="alert" error message on rejection and resets busy state', async () => {
    const onSignIn = vi.fn().mockRejectedValue(new Error('Network error'));

    await act(async () => {
      root!.render(<KeycloakAuthPage onSignIn={onSignIn} />);
    });

    const button = container!.querySelector('button')!;

    await act(async () => {
      button.click();
    });

    const alert = container!.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe('Sign-in is temporarily unavailable. Please try again.');
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Continue with Keycloak');
  });
});
