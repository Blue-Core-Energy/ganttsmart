import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  round,
  routeDependencyArrows,
  type DependencyArrowEdge,
  type DependencyEdge,
  type RoutedDependencyArrow,
} from '@/utils/dependencyArrows';

interface Props {
  /** Arrows to draw, already rolled up to the visible bars */
  edges: DependencyEdge[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  depViolations?: Map<string, string[]>;
  /** Explicit layout driver / SVG width matching the table content width */
  contentWidth?: number;
  /** Layout drivers — ensure arrows recompute on zoom or column changes even if table width stays viewport-padded */
  dayWidth?: number;
  fixedColsWidth?: number;
  selectedArrow?: { sourceId: string; targetId: string } | null;
  onSelectArrow?: (sourceId: string, targetId: string) => void;
}

interface Arrow extends DependencyArrowEdge {
  violated: boolean;
  crossProject: boolean;
}

interface ArrowPathProps {
  arrow: RoutedDependencyArrow & Arrow;
  isSelected: boolean;
  hasSelection: boolean;
  onSelectArrow?: (sourceId: string, targetId: string) => void;
}

function ArrowPathItem({ arrow: a, isSelected, hasSelection, onSelectArrow }: ArrowPathProps) {
  const color = a.violated ? '#f97316' : a.crossProject ? '#8b5cf6' : '#ef4444';
  const markerId = a.violated ? 'dep-arrow-warn' : a.crossProject ? 'dep-arrow-cross' : 'dep-arrow';

  // Solid subtle stroke for normal dependencies; dashed for violated and cross-project
  const strokeDasharray = a.violated ? '8 4' : a.crossProject ? '4 3' : undefined;

  const strokeWidth = isSelected ? (a.violated ? 3 : 2.5) : a.violated ? 2 : 1.5;
  const opacity = isSelected ? 1 : hasSelection ? 0.15 : a.violated ? 0.85 : 0.65;

  return (
    <g>
      {/* Wider transparent hit-target path for easy click selection */}
      <path
        d={a.path}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        className="pointer-events-auto cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          onSelectArrow?.(a.sourceId, a.targetId);
        }}
        data-arrow-hit-target={`${a.sourceId}->${a.targetId}`}
        aria-label={`Dependency: ${a.sourceId} blocks ${a.targetId}`}
      />
      {/* Visual arrow path */}
      <path
        d={a.path}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
        opacity={opacity}
        markerEnd={`url(#${markerId})`}
        data-arrow-source={a.sourceId}
        data-arrow-target={a.targetId}
        data-cross-project={a.crossProject ? 'true' : undefined}
        data-selected={isSelected ? 'true' : undefined}
        className="pointer-events-none transition-[opacity,stroke-width] duration-150"
      />
    </g>
  );
}

export default memo(function DependencyArrows({
  edges,
  containerRef,
  depViolations,
  contentWidth,
  dayWidth,
  fixedColsWidth,
  selectedArrow,
  onSelectArrow,
}: Props) {
  const [arrows, setArrows] = useState<(RoutedDependencyArrow & Arrow)[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const computeArrows = useCallback(() => {
    void dayWidth;
    void fixedColsWidth;
    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const rawArrows: Arrow[] = [];

    for (const edge of edges) {
      const fromBar = container.querySelector(`[data-task-bar="${edge.sourceId}"]`) as HTMLElement | null;
      const toBar = container.querySelector(`[data-task-bar="${edge.targetId}"]`) as HTMLElement | null;
      if (!fromBar || !toBar) continue;
      const fromRect = fromBar.getBoundingClientRect();
      const toRect = toBar.getBoundingClientRect();

      // Violated when any dependency behind this arrow has the blocked task starting before its blocker is due
      const violated = edge.members.some((m) => depViolations?.get(m.targetId)?.includes(m.sourceId));

      rawArrows.push({
        fromX: fromRect.right - containerRect.left,
        fromY: fromRect.top + fromRect.height / 2 - containerRect.top,
        toX: toRect.left - containerRect.left,
        toY: toRect.top + toRect.height / 2 - containerRect.top,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        violated,
        crossProject: edge.crossProject,
      });
    }

    const routed = routeDependencyArrows(rawArrows);
    setArrows(routed);
    const table = container.querySelector('table');
    const computedWidth = contentWidth ?? (table ? table.offsetWidth : container.clientWidth);
    const computedHeight = table ? table.offsetHeight : container.clientHeight;
    setSize({ width: computedWidth, height: computedHeight });
  }, [edges, containerRef, depViolations, contentWidth, dayWidth, fixedColsWidth]);

  useEffect(() => {
    // Initial compute after paint
    const frame = requestAnimationFrame(computeArrows);

    const container = containerRef.current;
    if (!container) return () => cancelAnimationFrame(frame);

    const observer = new ResizeObserver(computeArrows);
    observer.observe(container);
    // The container is a block element, so its box stays the viewport width while
    // the chart grows sideways. Observe the table too, otherwise zooming and
    // switching time scale move the bars without recomputing the arrows.
    const table = container.querySelector('table');
    if (table) observer.observe(table);
    window.addEventListener('resize', computeArrows);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', computeArrows);
    };
  }, [computeArrows, containerRef]);

  // Paint selected arrow last so it sits on top of non-selected arrows
  const sortedArrows = useMemo(() => {
    if (!selectedArrow) return arrows;
    return [...arrows].sort((a, b) => {
      const aSel = a.sourceId === selectedArrow.sourceId && a.targetId === selectedArrow.targetId;
      const bSel = b.sourceId === selectedArrow.sourceId && b.targetId === selectedArrow.targetId;
      return Number(aSel) - Number(bSel);
    });
  }, [arrows, selectedArrow]);

  // Deduplicate junctions so stacked translucent circles don't compound alpha
  const uniqueJunctions = useMemo(() => {
    const map = new Map<
      string,
      {
        x: number;
        y: number;
        participating: (RoutedDependencyArrow & Arrow)[];
      }
    >();

    for (const arrow of arrows) {
      for (const j of arrow.junctions ?? []) {
        const key = `${round(j.x)}|${round(j.y)}`;
        let entry = map.get(key);
        if (!entry) {
          entry = { x: j.x, y: j.y, participating: [] };
          map.set(key, entry);
        }
        entry.participating.push(arrow);
      }
    }

    const list = Array.from(map.values());
    if (!selectedArrow) return list;

    // Paint selected junction last so it sits on top of non-selected junctions
    return list.sort((a, b) => {
      const aSel = a.participating.some(
        (ar) => ar.sourceId === selectedArrow.sourceId && ar.targetId === selectedArrow.targetId,
      );
      const bSel = b.participating.some(
        (ar) => ar.sourceId === selectedArrow.sourceId && ar.targetId === selectedArrow.targetId,
      );
      return Number(aSel) - Number(bSel);
    });
  }, [arrows, selectedArrow]);

  if (arrows.length === 0) return null;

  const hasSelection = Boolean(selectedArrow);

  return (
    // z-[1] keeps arrows under the task bars (z-[2]) while still painting over the
    // today line, which shares z-[1] but comes earlier in the DOM
    <svg
      className="absolute top-0 left-0 pointer-events-none z-[1]"
      width={contentWidth ?? size.width}
      height={size.height}
      style={{ overflow: 'visible' }}
    >
      {/* markerUnits="userSpaceOnUse" keeps every head 8px long regardless of stroke
          width, so it always fits inside the arrow's final approach (ARROW_STUB) */}
      <defs>
        <marker
          id="dep-arrow"
          markerUnits="userSpaceOnUse"
          markerWidth="8"
          markerHeight="6"
          refX="7"
          refY="3"
          orient="auto"
        >
          <polygon points="0 0, 8 3, 0 6" fill="#ef4444" opacity="0.8" />
        </marker>
        <marker
          id="dep-arrow-warn"
          markerUnits="userSpaceOnUse"
          markerWidth="8"
          markerHeight="6"
          refX="7"
          refY="3"
          orient="auto"
        >
          <polygon points="0 0, 8 3, 0 6" fill="#f97316" opacity="0.9" />
        </marker>
        <marker
          id="dep-arrow-cross"
          markerUnits="userSpaceOnUse"
          markerWidth="8"
          markerHeight="6"
          refX="7"
          refY="3"
          orient="auto"
        >
          <polygon points="0 0, 8 3, 0 6" fill="#8b5cf6" opacity="0.85" />
        </marker>
      </defs>
      {sortedArrows.map((a) => {
        const isSelected = selectedArrow?.sourceId === a.sourceId && selectedArrow?.targetId === a.targetId;
        return (
          <ArrowPathItem
            key={`${a.sourceId}->${a.targetId}`}
            arrow={a}
            isSelected={isSelected}
            hasSelection={hasSelection}
            onSelectArrow={onSelectArrow}
          />
        );
      })}
      {uniqueJunctions.map((junction) => {
        const isSelected = Boolean(
          selectedArrow &&
          junction.participating.some(
            (a) => a.sourceId === selectedArrow.sourceId && a.targetId === selectedArrow.targetId,
          ),
        );

        let color: string;
        let opacity: number;
        let r: number;

        if (isSelected) {
          const selArrow = junction.participating.find(
            (a) => a.sourceId === selectedArrow!.sourceId && a.targetId === selectedArrow!.targetId,
          )!;
          color = selArrow.violated ? '#f97316' : selArrow.crossProject ? '#8b5cf6' : '#ef4444';
          opacity = 1;
          r = 3.5;
        } else if (hasSelection) {
          const hasViolated = junction.participating.some((a) => a.violated);
          const hasCross = junction.participating.some((a) => a.crossProject);
          color = hasViolated ? '#f97316' : hasCross ? '#8b5cf6' : '#ef4444';
          opacity = 0.15;
          r = 2.75;
        } else {
          const hasViolated = junction.participating.some((a) => a.violated);
          const hasCross = junction.participating.some((a) => a.crossProject);
          color = hasViolated ? '#f97316' : hasCross ? '#8b5cf6' : '#ef4444';
          opacity = hasViolated ? 0.85 : 0.65;
          r = 2.75;
        }

        const cx = round(junction.x);
        const cy = round(junction.y);

        return (
          <circle
            key={`${cx}|${cy}`}
            data-arrow-junction
            cx={cx}
            cy={cy}
            r={r}
            fill={color}
            opacity={opacity}
            className="pointer-events-none transition-[opacity,r] duration-150"
          />
        );
      })}
    </svg>
  );
});
