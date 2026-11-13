import { memo, useCallback, useEffect, useState } from 'react';
import type { Task } from '@/types';

interface Props {
  tasks: Task[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  depViolations?: Map<string, string[]>;
}

interface Arrow {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  sourceId: string;
  targetId: string;
  violated: boolean;
  crossProject: boolean;
}

function ArrowPath({ arrow: a }: { arrow: Arrow }) {
  const dx = a.toX - a.fromX;
  const dy = a.toY - a.fromY;
  const color = a.violated ? '#f97316' : a.crossProject ? '#8b5cf6' : '#ef4444';
  const markerId = a.violated ? 'dep-arrow-warn' : a.crossProject ? 'dep-arrow-cross' : 'dep-arrow';

  let path: string;
  if (Math.abs(dy) < 5 && dx > 0) {
    // Nearly horizontal — straight line
    path = `M ${a.fromX} ${a.fromY} L ${a.toX} ${a.toY}`;
  } else if (dx > 30) {
    // Normal: target bar starts after source bar ends
    const cx = Math.min(Math.abs(dx) * 0.4, 60);
    path = `M ${a.fromX} ${a.fromY} C ${a.fromX + cx} ${a.fromY}, ${a.toX - cx} ${a.toY}, ${a.toX} ${a.toY}`;
  } else {
    // Overlapping or reversed — route around with an S-curve
    const loopOut = 40;
    const midY = a.fromY + (a.toY - a.fromY) / 2;
    path = `M ${a.fromX} ${a.fromY} C ${a.fromX + loopOut} ${a.fromY}, ${a.fromX + loopOut} ${midY}, ${(a.fromX + a.toX) / 2} ${midY} S ${a.toX - loopOut} ${a.toY}, ${a.toX} ${a.toY}`;
  }

  return (
    <path
      d={path}
      fill="none"
      stroke={color}
      strokeWidth={a.violated ? 2 : 1.5}
      strokeDasharray={a.violated ? '8 4' : a.crossProject ? '4 3' : '6 3'}
      opacity={a.violated ? 0.85 : 0.65}
      markerEnd={`url(#${markerId})`}
      data-arrow-source={a.sourceId}
      data-arrow-target={a.targetId}
      data-cross-project={a.crossProject ? 'true' : undefined}
    />
  );
}

export default memo(function DependencyArrows({ tasks, containerRef, depViolations }: Props) {
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const computeArrows = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const seenEdges = new Set<string>();
    const newArrows: Arrow[] = [];

    for (const task of tasks) {
      if (task.blocks.length === 0) continue;

      const fromBar = container.querySelector(`[data-task-bar="${task.id}"]`) as HTMLElement | null;
      if (!fromBar) continue;
      const fromRect = fromBar.getBoundingClientRect();

      for (const blockedId of task.blocks) {
        const edgeKey = `${task.id}->${blockedId}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);

        const toBar = container.querySelector(`[data-task-bar="${blockedId}"]`) as HTMLElement | null;
        if (!toBar) continue;
        const toRect = toBar.getBoundingClientRect();

        // Check if this specific dependency is violated (blocked task starts before blocker is due)
        const violated = depViolations?.get(blockedId)?.includes(task.id) ?? false;
        const targetTask = taskById.get(blockedId);
        const crossProject = Boolean(task.isExternal || targetTask?.isExternal);

        newArrows.push({
          fromX: fromRect.right - containerRect.left,
          fromY: fromRect.top + fromRect.height / 2 - containerRect.top,
          toX: toRect.left - containerRect.left,
          toY: toRect.top + toRect.height / 2 - containerRect.top,
          sourceId: task.id,
          targetId: blockedId,
          violated,
          crossProject,
        });
      }
    }

    setArrows(newArrows);
    setSize({ width: container.scrollWidth, height: container.scrollHeight });
  }, [tasks, containerRef, depViolations]);

  useEffect(() => {
    // Initial compute after paint
    const frame = requestAnimationFrame(computeArrows);

    const container = containerRef.current;
    if (!container) return () => cancelAnimationFrame(frame);

    const observer = new ResizeObserver(computeArrows);
    observer.observe(container);
    window.addEventListener('resize', computeArrows);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', computeArrows);
    };
  }, [computeArrows, containerRef]);

  if (arrows.length === 0) return null;

  return (
    <svg
      className="absolute top-0 left-0 pointer-events-none z-[3]"
      width={size.width}
      height={size.height}
      style={{ overflow: 'visible' }}
    >
      <defs>
        <marker id="dep-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#ef4444" opacity="0.8" />
        </marker>
        <marker id="dep-arrow-warn" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#f97316" opacity="0.9" />
        </marker>
        <marker id="dep-arrow-cross" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#8b5cf6" opacity="0.85" />
        </marker>
      </defs>
      {arrows.map((a) => (
        <ArrowPath key={`${a.sourceId}-${a.targetId}`} arrow={a} />
      ))}
    </svg>
  );
});
