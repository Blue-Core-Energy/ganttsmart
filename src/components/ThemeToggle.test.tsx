// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeToggle from './ThemeToggle';

describe('ThemeToggle', () => {
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
    vi.unstubAllGlobals();
  });

  it('renders theme options with active state on the current theme', async () => {
    const onThemeChange = vi.fn();

    await act(async () => {
      root!.render(<ThemeToggle theme="light" onThemeChange={onThemeChange} />);
    });

    const buttons = container!.querySelectorAll('button');
    expect(buttons).toHaveLength(3);

    expect(buttons[0].getAttribute('title')).toBe('Light');
    expect(buttons[0].className).toContain('bg-bg-card');
    expect(buttons[1].className).not.toContain('bg-bg-card');
    expect(buttons[2].className).not.toContain('bg-bg-card');

    await act(async () => {
      root!.render(<ThemeToggle theme="dark" onThemeChange={onThemeChange} />);
    });

    expect(buttons[0].className).not.toContain('bg-bg-card');
    expect(buttons[1].getAttribute('title')).toBe('Dark');
    expect(buttons[1].className).toContain('bg-bg-card');
    expect(buttons[2].className).not.toContain('bg-bg-card');
  });

  it('invokes onThemeChange callback when a theme button is clicked', async () => {
    const onThemeChange = vi.fn();

    await act(async () => {
      root!.render(<ThemeToggle theme="light" onThemeChange={onThemeChange} />);
    });

    const buttons = container!.querySelectorAll('button');
    const darkButton = buttons[1];
    expect(darkButton.getAttribute('title')).toBe('Dark');

    await act(async () => {
      darkButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onThemeChange).toHaveBeenCalledTimes(1);
    expect(onThemeChange).toHaveBeenCalledWith('dark');

    const systemButton = buttons[2];
    await act(async () => {
      systemButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onThemeChange).toHaveBeenCalledTimes(2);
    expect(onThemeChange).toHaveBeenCalledWith('system');
  });
});
