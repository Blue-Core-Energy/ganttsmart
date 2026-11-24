// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DependencyEdge } from '@/utils/dependencyArrows';
import DependencyArrows from './DependencyArrows';

describe('DependencyArrows component', () => {
  let container: HTMLDivElement | null = null;
  let chartContainer: HTMLDivElement | null = null;
  let root: Root | null = null;

  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    container = document.createElement('div');
    document.body.appendChild(container);

    chartContainer = document.createElement('div');
    container.appendChild(chartContainer);

    chartContainer.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    chartContainer = null;
    vi.unstubAllGlobals();
  });

  function setupTaskBar(id: string, rect: { left: number; right: number; top: number; bottom: number }) {
    const bar = document.createElement('div');
    bar.setAttribute('data-task-bar', id);
    bar.getBoundingClientRect = () => ({
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => {},
    });
    chartContainer!.appendChild(bar);
  }

  it('renders deduplicated <circle data-arrow-junction> elements once per junction', async () => {
    // Tasks: A -> T and B -> T (shared target T)
    // A: (fromX: 100, fromY: 50)
    setupTaskBar('A', { left: 0, right: 100, top: 40, bottom: 60 });
    // B: (fromX: 200, fromY: 100)
    setupTaskBar('B', { left: 100, right: 200, top: 90, bottom: 110 });
    // T: (toX: 400, toY: 200)
    setupTaskBar('T', { left: 400, right: 500, top: 190, bottom: 210 });

    const edges: DependencyEdge[] = [
      { sourceId: 'A', targetId: 'T', members: [{ sourceId: 'A', targetId: 'T' }], crossProject: false },
      { sourceId: 'B', targetId: 'T', members: [{ sourceId: 'B', targetId: 'T' }], crossProject: false },
    ];

    await act(async () => {
      root!.render(<DependencyArrows edges={edges} containerRef={{ current: chartContainer }} contentWidth={1000} />);
    });

    const junctions = container!.querySelectorAll('circle[data-arrow-junction]');
    // Exactly 1 junction where B->T merges into A->T's vertical trunk at (388, 100)
    expect(junctions).toHaveLength(1);

    const circle = junctions[0];
    expect(circle.getAttribute('cx')).toBe('388');
    expect(circle.getAttribute('cy')).toBe('100');
    expect(circle.getAttribute('r')).toBe('2.75');
    expect(circle.getAttribute('fill')).toBe('#ef4444');
    expect(circle.getAttribute('opacity')).toBe('0.65');
    expect(circle.getAttribute('class')).toContain('pointer-events-none');

    // Assert paint order: circle elements are appended after path / group elements
    const svg = container!.querySelector('svg')!;
    const allChildren = Array.from(svg.children);
    const lastGroupIdx = allChildren.findLastIndex((el) => el.tagName.toLowerCase() === 'g');
    const firstCircleIdx = allChildren.findIndex((el) => el.tagName.toLowerCase() === 'circle');
    expect(firstCircleIdx).toBeGreaterThan(lastGroupIdx);
  });

  it('highlights junction dot when a participating arrow is selected', async () => {
    setupTaskBar('A', { left: 0, right: 100, top: 40, bottom: 60 });
    setupTaskBar('B', { left: 100, right: 200, top: 90, bottom: 110 });
    setupTaskBar('T', { left: 400, right: 500, top: 190, bottom: 210 });

    const edges: DependencyEdge[] = [
      { sourceId: 'A', targetId: 'T', members: [{ sourceId: 'A', targetId: 'T' }], crossProject: false },
      { sourceId: 'B', targetId: 'T', members: [{ sourceId: 'B', targetId: 'T' }], crossProject: false },
    ];

    await act(async () => {
      root!.render(
        <DependencyArrows
          edges={edges}
          containerRef={{ current: chartContainer }}
          contentWidth={1000}
          selectedArrow={{ sourceId: 'B', targetId: 'T' }}
        />,
      );
    });

    const junctions = container!.querySelectorAll('circle[data-arrow-junction]');
    expect(junctions).toHaveLength(1);

    const circle = junctions[0];
    // Participating arrow B->T is selected => opacity: 1, r: 3.5
    expect(circle.getAttribute('opacity')).toBe('1');
    expect(circle.getAttribute('r')).toBe('3.5');
    expect(circle.getAttribute('fill')).toBe('#ef4444');
  });

  it('dims junction dot when an unrelated arrow is selected', async () => {
    setupTaskBar('A', { left: 0, right: 100, top: 40, bottom: 60 });
    setupTaskBar('B', { left: 100, right: 200, top: 90, bottom: 110 });
    setupTaskBar('T', { left: 400, right: 500, top: 190, bottom: 210 });
    // An unrelated task pair
    setupTaskBar('X', { left: 600, right: 700, top: 40, bottom: 60 });
    setupTaskBar('Y', { left: 800, right: 900, top: 100, bottom: 120 });

    const edges: DependencyEdge[] = [
      { sourceId: 'A', targetId: 'T', members: [{ sourceId: 'A', targetId: 'T' }], crossProject: false },
      { sourceId: 'B', targetId: 'T', members: [{ sourceId: 'B', targetId: 'T' }], crossProject: false },
      { sourceId: 'X', targetId: 'Y', members: [{ sourceId: 'X', targetId: 'Y' }], crossProject: false },
    ];

    await act(async () => {
      root!.render(
        <DependencyArrows
          edges={edges}
          containerRef={{ current: chartContainer }}
          contentWidth={1000}
          selectedArrow={{ sourceId: 'X', targetId: 'Y' }}
        />,
      );
    });

    const junctions = container!.querySelectorAll('circle[data-arrow-junction]');
    expect(junctions).toHaveLength(1);

    const circle = junctions[0];
    // A/B->T junction is not participating in selected arrow X->Y => dimmed opacity: 0.15, r: 2.75
    expect(circle.getAttribute('opacity')).toBe('0.15');
    expect(circle.getAttribute('r')).toBe('2.75');
  });

  it('applies highest severity color and opacity (violated > crossProject > normal)', async () => {
    setupTaskBar('A', { left: 0, right: 100, top: 40, bottom: 60 });
    setupTaskBar('B', { left: 100, right: 200, top: 90, bottom: 110 });
    setupTaskBar('T', { left: 400, right: 500, top: 190, bottom: 210 });

    // Case 1: crossProject arrow
    const crossEdges: DependencyEdge[] = [
      { sourceId: 'A', targetId: 'T', members: [{ sourceId: 'A', targetId: 'T' }], crossProject: true },
      { sourceId: 'B', targetId: 'T', members: [{ sourceId: 'B', targetId: 'T' }], crossProject: false },
    ];

    await act(async () => {
      root!.render(
        <DependencyArrows edges={crossEdges} containerRef={{ current: chartContainer }} contentWidth={1000} />,
      );
    });

    let junctions = container!.querySelectorAll('circle[data-arrow-junction]');
    expect(junctions).toHaveLength(1);
    expect(junctions[0].getAttribute('fill')).toBe('#8b5cf6');
    expect(junctions[0].getAttribute('opacity')).toBe('0.65');

    // Case 2: violated arrow (violated overrides crossProject and uses 0.85 opacity)
    const depViolations = new Map<string, string[]>([['T', ['A']]]);

    await act(async () => {
      root!.render(
        <DependencyArrows
          edges={crossEdges}
          containerRef={{ current: chartContainer }}
          depViolations={depViolations}
          contentWidth={1000}
        />,
      );
    });

    junctions = container!.querySelectorAll('circle[data-arrow-junction]');
    expect(junctions).toHaveLength(1);
    expect(junctions[0].getAttribute('fill')).toBe('#f97316');
    expect(junctions[0].getAttribute('opacity')).toBe('0.85');
  });

  it('highlights all participating junctions when an arrow participating in 2+ junctions is selected', async () => {
    // Top -> T (fromX: 100, fromY: 50, toX: 400, toY: 250)
    // S -> T   (fromX: 100, fromY: 100, toX: 400, toY: 250)
    // S -> D   (fromX: 100, fromY: 100, toX: 600, toY: 150)
    // S->T participates in:
    // 1. Branch junction with S->D at (112, 100)
    // 2. Merge junction with Top->T at (388, 100)
    setupTaskBar('Top', { left: 0, right: 100, top: 40, bottom: 60 });
    setupTaskBar('S', { left: 0, right: 100, top: 90, bottom: 110 });
    setupTaskBar('T', { left: 400, right: 500, top: 240, bottom: 260 });
    setupTaskBar('D', { left: 600, right: 700, top: 140, bottom: 160 });

    const edges: DependencyEdge[] = [
      { sourceId: 'Top', targetId: 'T', members: [{ sourceId: 'Top', targetId: 'T' }], crossProject: false },
      { sourceId: 'S', targetId: 'T', members: [{ sourceId: 'S', targetId: 'T' }], crossProject: false },
      { sourceId: 'S', targetId: 'D', members: [{ sourceId: 'S', targetId: 'D' }], crossProject: false },
    ];

    await act(async () => {
      root!.render(
        <DependencyArrows
          edges={edges}
          containerRef={{ current: chartContainer }}
          contentWidth={1000}
          selectedArrow={{ sourceId: 'S', targetId: 'T' }}
        />,
      );
    });

    const junctions = container!.querySelectorAll('circle[data-arrow-junction]');
    expect(junctions).toHaveLength(2);

    // Both junctions must be highlighted since S->T participates in both!
    for (const circle of junctions) {
      expect(circle.getAttribute('opacity')).toBe('1');
      expect(circle.getAttribute('r')).toBe('3.5');
    }
  });
});
