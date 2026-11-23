import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportAsPdf, exportAsPng } from './export';

const mockToPng = vi.fn();
vi.mock('html-to-image', () => ({
  toPng: (...args: unknown[]) => mockToPng(...args),
}));

const mockPdfSave = vi.fn();
const mockPdfAddImage = vi.fn();
vi.mock('jspdf', () => ({
  jsPDF: class {
    addImage = mockPdfAddImage;
    save = mockPdfSave;
  },
}));

describe('export utilities', () => {
  let createdElements: HTMLAnchorElement[];

  beforeEach(() => {
    createdElements = [];
    mockToPng.mockReset();
    mockPdfSave.mockReset();
    mockPdfAddImage.mockReset();

    // Stub global getComputedStyle
    vi.stubGlobal('getComputedStyle', () => ({
      backgroundColor: 'rgb(9, 9, 11)',
    }));

    // Stub global Image constructor
    class MockImage {
      width = 800;
      height = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_val: string) {
        setTimeout(() => this.onload?.(), 0);
      }
    }
    vi.stubGlobal('Image', MockImage);

    // Stub global document
    const bodyChildren: HTMLElement[] = [];
    vi.stubGlobal('document', {
      body: {
        appendChild: (child: HTMLElement) => {
          bodyChildren.push(child);
          return child;
        },
        removeChild: (child: HTMLElement) => {
          const idx = bodyChildren.indexOf(child);
          if (idx >= 0) bodyChildren.splice(idx, 1);
          return child;
        },
      },
      createElement: (tag: string) => {
        const el = {
          tagName: tag.toUpperCase(),
          download: '',
          href: '',
          click: vi.fn(),
        } as unknown as HTMLAnchorElement;
        createdElements.push(el);
        return el;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createMockExportTarget() {
    const hiddenChild = {
      hasAttribute: (name: string) => name === 'data-export-hide',
      style: { display: 'block' },
    } as unknown as HTMLElement;

    const visibleChild = {
      hasAttribute: (_name: string) => false,
      style: { display: 'flex' },
    } as unknown as HTMLElement;

    const target = {
      scrollWidth: 1200,
      scrollHeight: 800,
      style: {
        overflow: 'auto',
        overflowX: 'auto',
        width: '100%',
        maxWidth: '100%',
      },
      hasAttribute: (_name: string) => false,
      querySelectorAll: (selector: string) => {
        if (selector === '[data-export-hide]') return [hiddenChild];
        return [];
      },
    } as unknown as HTMLElement;

    return { target, hiddenChild, visibleChild };
  }

  it('exportAsPng hides data-export-hide elements during capture and restores styles', async () => {
    const { target, hiddenChild } = createMockExportTarget();
    mockToPng.mockImplementation(async (_el, options) => {
      // While inside toPng, hidden child display should have been set to 'none'
      expect(hiddenChild.style.display).toBe('none');

      // Test the filter function
      const filter = options.filter;
      expect(filter(hiddenChild)).toBe(false);
      expect(filter({ hasAttribute: () => false })).toBe(true);

      return 'data:image/png;base64,mockpngdata';
    });

    await exportAsPng(target);

    // Target overflow and width styles restored
    expect(target.style.overflow).toBe('auto');
    expect(target.style.overflowX).toBe('auto');
    expect(target.style.width).toBe('100%');
    expect(target.style.maxWidth).toBe('100%');

    // Hidden child's display style restored
    expect(hiddenChild.style.display).toBe('block');

    // A link was created, configured, clicked, and removed
    expect(createdElements.length).toBe(1);
    const link = createdElements[0];
    expect(link.download).toMatch(/^gantt-\d{4}-\d{2}-\d{2}\.png$/);
    expect(link.href).toBe('data:image/png;base64,mockpngdata');
    expect(link.click).toHaveBeenCalled();
  });

  it('exportAsPng restores styles even when toPng fails', async () => {
    const { target, hiddenChild } = createMockExportTarget();
    mockToPng.mockRejectedValue(new Error('Canvas render failure'));

    await expect(exportAsPng(target)).rejects.toThrow('Canvas render failure');

    expect(target.style.overflow).toBe('auto');
    expect(hiddenChild.style.display).toBe('block');
  });

  it('exportAsPdf generates and saves a PDF document', async () => {
    const { target, hiddenChild } = createMockExportTarget();
    mockToPng.mockResolvedValue('data:image/png;base64,mockpngdata');

    await exportAsPdf(target);

    expect(hiddenChild.style.display).toBe('block');
    expect(mockPdfAddImage).toHaveBeenCalledWith('data:image/png;base64,mockpngdata', 'PNG', 0, 0, 400, 300);
    expect(mockPdfSave).toHaveBeenCalledWith(expect.stringMatching(/^gantt-\d{4}-\d{2}-\d{2}\.pdf$/));
  });
});
