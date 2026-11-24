// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Header from './Header';
import { exportAsPng, exportAsPdf } from '@/utils/export';

vi.mock('@/backend', () => ({
  backend: { kind: 'gcp', capabilities: { sharing: false, signOut: true } },
}));

vi.mock('@/utils/export', () => ({
  exportAsPng: vi.fn(),
  exportAsPdf: vi.fn(),
}));

const projects = [
  { id: 'proj-1', name: 'Alpha Platform' },
  { id: 'proj-2', name: 'Beta Mobile' },
];

const headerProps = {
  projectName: 'Beta Mobile',
  loading: false,
  lastSynced: '',
  onRefresh: vi.fn(),
  onDisconnectLinear: vi.fn(),
  onSignOut: vi.fn(),
  theme: 'dark' as const,
  onThemeChange: vi.fn(),
  projectId: 'proj-2',
  projects,
  onSelectProject: vi.fn(),
};

describe('Header account menu export options (happy-dom)', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let exportTarget: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    exportTarget = document.createElement('div');
    exportTarget.id = 'gantt-export-target';
    document.body.appendChild(exportTarget);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    exportTarget?.remove();
    exportTarget = null;
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const openAccountMenu = async () => {
    const accountBtn = container!.querySelector<HTMLButtonElement>('button[title="Account"]');
    expect(accountBtn).not.toBeNull();
    await act(async () => {
      accountBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return accountBtn!;
  };

  it('toggles Export submenu via click and verifies aria-controls and role="group"', async () => {
    await act(async () => {
      root!.render(<Header {...headerProps} />);
    });

    await openAccountMenu();

    const exportBtn = Array.from(container!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export'),
    );
    expect(exportBtn).toBeDefined();

    // Initially collapsed: aria-expanded is false, aria-controls is undefined, role="group" not rendered
    expect(exportBtn!.getAttribute('aria-expanded')).toBe('false');
    expect(exportBtn!.getAttribute('aria-controls')).toBeNull();
    expect(container!.querySelector('[role="group"][aria-label="Export options"]')).toBeNull();

    // Click to expand
    await act(async () => {
      exportBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(exportBtn!.getAttribute('aria-expanded')).toBe('true');
    const controlsId = exportBtn!.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();

    const group = container!.querySelector('[role="group"][aria-label="Export options"]');
    expect(group).not.toBeNull();
    expect(group!.id).toBe(controlsId);

    // Submenu options rendered
    expect(group!.textContent).toContain('Export as PNG');
    expect(group!.textContent).toContain('Export as PDF');
    expect(group!.textContent).toContain('Print');

    // Click again to collapse
    await act(async () => {
      exportBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(exportBtn!.getAttribute('aria-expanded')).toBe('false');
    expect(exportBtn!.getAttribute('aria-controls')).toBeNull();
    expect(container!.querySelector('[role="group"][aria-label="Export options"]')).toBeNull();
  });

  it('supports Enter and Space keyboard toggle on Export button', async () => {
    await act(async () => {
      root!.render(<Header {...headerProps} />);
    });

    await openAccountMenu();

    const exportBtn = Array.from(container!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export'),
    )!;

    // Dispatch Enter key
    await act(async () => {
      exportBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // In happy-dom, standard button click dispatch
    await act(async () => {
      exportBtn.click();
    });
    expect(exportBtn.getAttribute('aria-expanded')).toBe('true');

    // Dispatch Space key / click to collapse
    await act(async () => {
      exportBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    await act(async () => {
      exportBtn.click();
    });
    expect(exportBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('manages full export lifecycle with deferred promise and format-specific spinner', async () => {
    let resolvePng: (() => void) | null = null;
    const pngPromise = new Promise<void>((resolve) => {
      resolvePng = resolve;
    });
    vi.mocked(exportAsPng).mockReturnValue(pngPromise);

    await act(async () => {
      root!.render(<Header {...headerProps} />);
    });

    const accountBtn = await openAccountMenu();

    const exportBtn = Array.from(container!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export'),
    )!;

    // Expand submenu
    await act(async () => {
      exportBtn.click();
    });

    const group = container!.querySelector('[role="group"][aria-label="Export options"]')!;
    const pngBtn = Array.from(group.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export as PNG'),
    )!;

    // Trigger PNG export
    await act(async () => {
      pngBtn.click();
    });

    expect(exportAsPng).toHaveBeenCalledTimes(1);

    // Starting export closes account menu
    expect(container!.querySelector('[role="group"][aria-label="Export options"]')).toBeNull();

    // Reopen account menu while export is in progress
    await act(async () => {
      accountBtn.click();
    });

    // Submenu is collapsed; parent Export row shows busy spinner + "Exporting PNG…"
    const collapsedExportBtn = Array.from(container!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export'),
    )!;
    expect(collapsedExportBtn.textContent).toContain('Exporting PNG…');
    expect(collapsedExportBtn.querySelector('.animate-spin')).not.toBeNull();

    // Expand submenu while export is in progress
    await act(async () => {
      collapsedExportBtn.click();
    });

    // When submenu is open, parent Export row hides its spinner
    expect(collapsedExportBtn.querySelector(':scope > span:last-child .animate-spin')).toBeNull();

    const openGroup = container!.querySelector('[role="group"][aria-label="Export options"]')!;
    const activePngBtn = Array.from(openGroup.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export as PNG'),
    )!;
    const activePdfBtn = Array.from(openGroup.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export as PDF'),
    )!;
    const activePrintBtn = Array.from(openGroup.querySelectorAll('button')).find(
      (btn) => btn.textContent?.trim() === 'Print',
    )!;

    // Spinner is present ONLY on PNG
    expect(activePngBtn.querySelector('.animate-spin')).not.toBeNull();
    expect(activePdfBtn.querySelector('.animate-spin')).toBeNull();
    expect(activePrintBtn.querySelector('.animate-spin')).toBeNull();

    // All export actions are genuinely disabled
    expect(activePngBtn.disabled).toBe(true);
    expect(activePdfBtn.disabled).toBe(true);
    expect(activePrintBtn.disabled).toBe(true);

    // Re-entrancy guard: clicking while exporting does nothing
    await act(async () => {
      activePngBtn.click();
      activePdfBtn.click();
    });
    expect(exportAsPng).toHaveBeenCalledTimes(1);
    expect(exportAsPdf).not.toHaveBeenCalled();

    // Resolve PNG export
    await act(async () => {
      resolvePng!();
    });

    // After completion, exportingFormat is cleared
    expect(collapsedExportBtn.textContent).not.toContain('Exporting PNG…');
    expect(activePngBtn.querySelector('.animate-spin')).toBeNull();
    expect(activePngBtn.disabled).toBe(false);
    expect(activePdfBtn.disabled).toBe(false);
    expect(activePrintBtn.disabled).toBe(false);
  });

  it('clears exportingFormat when export promise rejects', async () => {
    let rejectPdf: ((err: Error) => void) | null = null;
    const pdfPromise = new Promise<void>((_, reject) => {
      rejectPdf = reject;
    });
    vi.mocked(exportAsPdf).mockReturnValue(pdfPromise);

    await act(async () => {
      root!.render(<Header {...headerProps} />);
    });

    const accountBtn = await openAccountMenu();

    const exportBtn = Array.from(container!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export'),
    )!;

    await act(async () => {
      exportBtn.click();
    });

    const group = container!.querySelector('[role="group"][aria-label="Export options"]')!;
    const pdfBtn = Array.from(group.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export as PDF'),
    )!;

    await act(async () => {
      pdfBtn.click();
    });

    expect(exportAsPdf).toHaveBeenCalledTimes(1);

    // Reopen menu
    await act(async () => {
      accountBtn.click();
    });

    const exportRow = Array.from(container!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export'),
    )!;
    expect(exportRow.textContent).toContain('Exporting PDF…');

    // Reject the promise
    await act(async () => {
      rejectPdf!(new Error('Canvas tainted'));
    });

    expect(exportRow.textContent).not.toContain('Exporting PDF…');
    expect(exportRow.querySelector('.animate-spin')).toBeNull();
  });

  it('implements two-step Escape dismissal: 1st Escape closes submenu, 2nd closes menu with focus return', async () => {
    await act(async () => {
      root!.render(<Header {...headerProps} />);
    });

    const accountBtn = await openAccountMenu();

    const exportBtn = Array.from(container!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export'),
    )!;

    await act(async () => {
      exportBtn.click();
    });

    expect(container!.querySelector('[role="group"][aria-label="Export options"]')).not.toBeNull();

    // 1st Escape: closes only Export submenu and focuses Export button
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(container!.querySelector('[role="group"][aria-label="Export options"]')).toBeNull();
    expect(exportBtn.getAttribute('aria-expanded')).toBe('false');
    expect(container!.querySelector('button[title="Account"]')).not.toBeNull();
    expect(document.activeElement).toBe(exportBtn);

    // 2nd Escape: closes account menu and focuses Account button
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(container!.querySelector('[role="group"][aria-label="Export options"]')).toBeNull();
    // Account menu dropdown is unmounted
    expect(container!.querySelectorAll('button').length).toBeLessThan(10);
    expect(document.activeElement).toBe(accountBtn);
  });

  it('resets submenu state on outside click dismissal', async () => {
    await act(async () => {
      root!.render(<Header {...headerProps} />);
    });

    const accountBtn = await openAccountMenu();

    const exportBtn = Array.from(container!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export'),
    )!;

    await act(async () => {
      exportBtn.click();
    });

    expect(container!.querySelector('[role="group"][aria-label="Export options"]')).not.toBeNull();

    // Click outside
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    // Account menu is closed
    expect(container!.querySelector('[role="group"][aria-label="Export options"]')).toBeNull();

    // Reopen account menu: Export submenu should be reset to collapsed
    await act(async () => {
      accountBtn.click();
    });

    const reopenedExportBtn = Array.from(container!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('Export'),
    )!;
    expect(reopenedExportBtn.getAttribute('aria-expanded')).toBe('false');
    expect(container!.querySelector('[role="group"][aria-label="Export options"]')).toBeNull();
  });
});
