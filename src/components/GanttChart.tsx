import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { InlineEditHandlers, Milestone, NonWorkDay, Task, TimeScale } from '@/types';
import type { TaskBaseline } from '@/hooks/usePlanningHistory';
import { Avatar } from '@/utils/avatar';
import { buildTimeCells, daysBetween, formatIsoDate, isWeekend, startOfWeek } from '@/utils/date';
import { buildArrowPath, resolveDependencyEdges } from '@/utils/dependencyArrows';
import { loadCollapsedParents, saveCollapsedParents } from '@/utils/collapsedParents';
import {
  anchorDayOffset,
  anchoredScrollLeft,
  dayOffsetToMs,
  msToDayOffset,
  wheelZoomFactor,
  zoomDayWidth,
} from '@/utils/timelineZoom';
import {
  computeStickyColumnOffsets,
  getColumnDef,
  loadColumnWidths,
  loadVisibleColumns,
  normalizeVisibleColumns,
  saveColumnWidths,
  saveVisibleColumns,
  totalColumnWidth,
  type ColumnKey,
  type ColumnWidths,
} from '@/utils/scheduleColumns';
import { applyCollapsedParents, buildTaskHierarchy, computeDepViolations } from '@/utils/tasks';
import ColumnPicker from './ColumnPicker';
import DependencyArrows from './DependencyArrows';
import GanttRow from './GanttRow';
import { openMilestonePanel } from './milestonePanelStore';

interface Props {
  tasks: Task[];
  unscheduledTasks?: Task[];
  milestones: Milestone[];
  loading: boolean;
  error: string;
  dayWidth: number;
  timeScale?: TimeScale;
  /** Omit to render the timeline at a fixed zoom — e.g. exports and tests */
  onDayWidthChange?: (next: (current: number) => number) => void;
  onReschedule?: (taskUuid: string, newDueDate: string) => Promise<void>;
  onRescheduleStart?: (taskUuid: string, newStartDate: string) => Promise<void>;
  onCycleStatus?: (taskUuid: string) => Promise<void>;
  /** Omit to keep status, assignee, and title read-only in the schedule table (shared views, exports) */
  inlineEdit?: InlineEditHandlers;
  onCreateRelation?: (sourceTaskId: string, targetTaskId: string) => Promise<void>;
  onReorder?: (draggedUuid: string, targetUuid: string, placeAfter: boolean) => void;
  /** Omit to render milestones read-only (no dragging) — e.g. shared views */
  onUpdateMilestoneDate?: (milestoneId: string, newTargetDate: string) => Promise<void>;
  baselines?: Map<string, TaskBaseline>;
  dateFrom?: string;
  dateTo?: string;
  externalTasksForViolations?: Task[];
  allowExternalEdits?: boolean;
  onSelectProject?: (projectId: string) => void;
  /** Name of the project being viewed, shown by the optional Project column */
  projectName?: string;
  /** Show every row even under a collapsed parent — set while search or filters are narrowing the list */
  ignoreCollapsed?: boolean;
  /** Shared holidays and PTO: shaded on the timeline and skipped by workday math. Omit for none. */
  nonWorkDays?: NonWorkDay[];
}

// Resize handle component
function ResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;

      const onMove = (ev: MouseEvent) => {
        onResize(ev.clientX - startX);
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [onResize],
  );

  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-[5px] cursor-col-resize z-10 group hover:bg-accent/30 transition-colors"
      onMouseDown={handleMouseDown}
    >
      <div className="absolute right-0 top-0 bottom-0 w-px bg-border-primary group-hover:bg-accent transition-colors" />
    </div>
  );
}

export default function GanttChart({
  tasks,
  unscheduledTasks = [],
  milestones,
  loading,
  error,
  dayWidth,
  timeScale = 'day',
  onDayWidthChange,
  onReschedule,
  onRescheduleStart,
  onCycleStatus,
  inlineEdit,
  onCreateRelation,
  onReorder,
  onUpdateMilestoneDate,
  baselines,
  dateFrom,
  dateTo,
  externalTasksForViolations,
  allowExternalEdits = false,
  onSelectProject,
  projectName,
  ignoreCollapsed = false,
  nonWorkDays,
}: Props) {
  const [unscheduledVisible, setUnscheduledVisible] = useState(true);
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(loadVisibleColumns);
  const [colWidths, setColWidths] = useState<ColumnWidths>(loadColumnWidths);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedArrow, setSelectedArrow] = useState<{ sourceId: string; targetId: string } | null>(null);

  const handleSelectArrow = useCallback((sourceId: string, targetId: string) => {
    setSelectedArrow((prev) => {
      if (prev && prev.sourceId === sourceId && prev.targetId === targetId) {
        return null;
      }
      return { sourceId, targetId };
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedArrow(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  );
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1200));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 768px)');
    const updateViewport = () => {
      setIsNarrowViewport(!mq.matches);
      setViewportWidth(window.innerWidth);
    };
    updateViewport();
    mq.addEventListener('change', updateViewport);
    window.addEventListener('resize', updateViewport);
    return () => {
      mq.removeEventListener('change', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, []);

  const stickyColumnInfo = useMemo(
    () =>
      computeStickyColumnOffsets(visibleColumns, colWidths, {
        isNarrow: isNarrowViewport,
        viewportWidth,
      }),
    [visibleColumns, colWidths, isNarrowViewport, viewportWidth],
  );

  const ganttRef = useRef<HTMLDivElement>(null);
  /** Date and pointer position to restore after a zoom, set by the wheel handler */
  const zoomAnchorRef = useRef<{ anchorMs: number; pointerOffsetX: number } | null>(null);
  /** Live geometry for the imperative wheel listener, which must not be re-bound per render */
  const geometryRef = useRef({ dayWidth, fixedColsWidth: 0, chartStartMs: 0 });
  const onDayWidthChangeRef = useRef(onDayWidthChange);
  onDayWidthChangeRef.current = onDayWidthChange;
  const panCleanupRef = useRef<(() => void) | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const baseWidthsRef = useRef<ColumnWidths>(colWidths);
  /** Mirrors colWidths for the resize handlers, which persist on mouseup */
  const liveWidthsRef = useRef<ColumnWidths>(colWidths);
  liveWidthsRef.current = colWidths;

  // Right-clicking any header toggles the picker, so a second right-click closes it
  const togglePickerFromContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setPickerOpen((open) => !open);
  }, []);

  const changeVisibleColumns = useCallback((next: ColumnKey[]) => {
    // Normalize up front so showing a column slots it into the canonical order
    // immediately, rather than appending until the next reload
    const normalized = normalizeVisibleColumns(next);
    setVisibleColumns(normalized);
    saveVisibleColumns(normalized);
  }, []);

  // Milestone drag — live pixel offset for the flag + line, committed on mouseup
  const [milestoneDrag, setMilestoneDrag] = useState<{ id: string; delta: number } | null>(null);
  const milestoneDragRef = useRef<{ id: string; startX: number; didDrag: boolean } | null>(null);

  // Header height drives where the milestone lines start (the header is sticky and
  // its height varies with the time scale and the milestone band).
  const [headerHeight, setHeaderHeight] = useState(64);
  const headerObserverRef = useRef<ResizeObserver | null>(null);

  // Connection drag state (imperative for performance — no re-renders during mousemove)
  const innerRef = useRef<HTMLDivElement>(null);
  const connectionSvgRef = useRef<SVGSVGElement>(null);
  const connectionPathRef = useRef<SVGPathElement>(null);
  const connectingFromRef = useRef<string | null>(null);
  const connectingSourcePos = useRef<{ x: number; y: number } | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const handleConnectStart = useCallback(
    (taskId: string, _e: React.MouseEvent) => {
      const container = innerRef.current;
      if (!container) return;

      connectingFromRef.current = taskId;
      setIsConnecting(true);

      // Find source bar position
      const bar = container.querySelector(`[data-task-bar="${taskId}"]`) as HTMLElement | null;
      if (!bar) return;
      const containerRect = container.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      connectingSourcePos.current = {
        x: barRect.right - containerRect.left,
        y: barRect.top + barRect.height / 2 - containerRect.top,
      };

      // Show connection SVG
      const svg = connectionSvgRef.current;
      if (svg) {
        svg.style.display = '';
        svg.setAttribute('width', String(container.scrollWidth));
        svg.setAttribute('height', String(container.scrollHeight));
      }

      document.body.style.cursor = 'crosshair';

      const onMove = (ev: MouseEvent) => {
        const src = connectingSourcePos.current;
        const path = connectionPathRef.current;
        if (!src || !path || !container) return;

        const rect = container.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;

        // Same routing as a committed arrow, so the preview predicts the result
        path.setAttribute('d', buildArrowPath({ fromX: src.x, fromY: src.y, toX: mx, toY: my }));

        // Highlight target bar under cursor
        const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const targetBar = el?.closest('[data-task-bar]') as HTMLElement | null;
        container.querySelectorAll('[data-task-bar]').forEach((b) => b.classList.remove('ring-2', 'ring-accent'));
        if (targetBar && targetBar.getAttribute('data-task-bar') !== taskId) {
          targetBar.classList.add('ring-2', 'ring-accent');
        }
      };

      const onUp = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';

        // Clean up highlights
        container.querySelectorAll('[data-task-bar]').forEach((b) => b.classList.remove('ring-2', 'ring-accent'));

        // Hide connection SVG
        const svg = connectionSvgRef.current;
        if (svg) svg.style.display = 'none';

        // Check if dropped on a valid target
        const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const targetBar = el?.closest('[data-task-bar]') as HTMLElement | null;
        const targetId = targetBar?.getAttribute('data-task-bar');

        connectingFromRef.current = null;
        connectingSourcePos.current = null;
        setIsConnecting(false);

        if (targetId && targetId !== taskId && onCreateRelation) {
          // Source blocks target
          onCreateRelation(taskId, targetId);
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [onCreateRelation],
  );

  // Clean up connection state on unmount
  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
    };
  }, []);

  // Measure the header so milestone lines start exactly below it. A callback ref
  // (not an effect) because the table mounts after the loading/error early returns.
  const theadRef = useCallback((el: HTMLTableSectionElement | null) => {
    headerObserverRef.current?.disconnect();
    headerObserverRef.current = null;
    if (!el) return;
    setHeaderHeight(el.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    ro.observe(el);
    headerObserverRef.current = ro;
  }, []);

  // Disconnect the header observer on unmount
  useEffect(() => () => headerObserverRef.current?.disconnect(), []);

  /**
   * Scroll container ref that also binds Ctrl/Cmd + wheel zoom. The listener has to
   * be non-passive to stop the browser zooming the whole page, which React's own
   * wheel handling can't do, and it reads geometry from a ref so it is bound once.
   */
  const scrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    ganttRef.current = el;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Ctrl is also what a trackpad pinch reports; Cmd covers macOS
      if (!e.ctrlKey && !e.metaKey) return;
      const change = onDayWidthChangeRef.current;
      if (!change) return;
      e.preventDefault();

      const { dayWidth: currentDayWidth, fixedColsWidth: cols, chartStartMs } = geometryRef.current;
      const nextDayWidth = zoomDayWidth(currentDayWidth, wheelZoomFactor(e.deltaY, e.deltaMode));
      if (nextDayWidth === currentDayWidth) return;

      const pointerOffsetX = e.clientX - el.getBoundingClientRect().left;
      // Only anchor when the pointer is over the timeline itself — zooming while
      // hovering the left schedule columns shouldn't jump scrollLeft to pin day 0
      if (el.scrollLeft + pointerOffsetX > cols) {
        const offsetDays = anchorDayOffset({
          pointerOffsetX,
          scrollLeft: el.scrollLeft,
          fixedColsWidth: cols,
          dayWidth: currentDayWidth,
        });
        // Anchor on the date rather than the offset: changing granularity can move the
        // chart start, and the date under the pointer should still be the date under it
        zoomAnchorRef.current = { anchorMs: dayOffsetToMs(chartStartMs, offsetDays), pointerOffsetX };
      }
      change(() => nextDayWidth);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    wheelCleanupRef.current = () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => () => wheelCleanupRef.current?.(), []);

  /**
   * Drag the empty timeline background to pan. Bars, handles, milestone flags and
   * connector dots sit above the background and are matched out, so this never
   * swallows a reschedule, a resize or a dependency drag.
   */
  const handleBackgroundPan = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest('[data-timeline-background]')) return;

    const el = ganttRef.current;
    if (!el) return;
    e.preventDefault();

    const startX = e.clientX;
    const startScrollLeft = el.scrollLeft;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      el.scrollLeft = startScrollLeft - (ev.clientX - startX);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      panCleanupRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    panCleanupRef.current = onUp;
  }, []);

  // Don't leave a grabbing cursor behind if the chart unmounts mid-drag
  useEffect(() => () => panCleanupRef.current?.(), []);

  // Column resize handlers — store base on first drag, apply delta
  const makeResizeHandler = useCallback(
    (col: ColumnKey) => {
      let baseSet = false;
      return (delta: number) => {
        if (!baseSet) {
          baseWidthsRef.current = { ...colWidths };
          baseSet = true;
          // Reset on mouseup, and persist the width the drag settled on. The live
          // widths come from a ref: saving inside a state updater would run twice
          // under StrictMode.
          const resetBase = () => {
            baseSet = false;
            document.removeEventListener('mouseup', resetBase);
            saveColumnWidths(liveWidthsRef.current);
          };
          document.addEventListener('mouseup', resetBase);
        }
        // Update the ref now rather than inside a state updater: React may defer the updater past
        // the mouseup, and the persisted widths would then miss the last move.
        const next = {
          ...liveWidthsRef.current,
          [col]: Math.max(baseWidthsRef.current[col] + delta, getColumnDef(col).minWidth),
        };
        liveWidthsRef.current = next;
        setColWidths(next);
      };
    },
    [colWidths],
  );

  // All computation must happen before early returns to respect Rules of Hooks
  const todayKey = new Date().toDateString();
  const today = useMemo(() => {
    const d = new Date(todayKey);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [todayKey]); // recompute on a new calendar day

  // Detect dependency violations: blocked active task starts before active blocker is due
  // Includes external tasks even when ghost rows are toggled off so local tasks still warn.
  const depViolations = useMemo(() => {
    if (!externalTasksForViolations || externalTasksForViolations.length === 0) {
      return computeDepViolations(tasks, today);
    }
    const seen = new Set(tasks.map((t) => t.id));
    const combined = [...tasks];
    for (const ext of externalTasksForViolations) {
      if (!seen.has(ext.id)) {
        seen.add(ext.id);
        combined.push(ext);
      }
    }
    return computeDepViolations(combined, today);
  }, [tasks, externalTasksForViolations, today]);

  // Sub-issues sit under their parent; collapsing a parent hides its descendants. The chart's date range
  // and dependency violations still use every task, so toggling never shifts the timeline.
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(loadCollapsedParents);
  const hierarchy = useMemo(() => buildTaskHierarchy(tasks), [tasks]);
  const { rows: visibleRows, hiddenInto } = useMemo(
    () => applyCollapsedParents(hierarchy, ignoreCollapsed ? new Set() : collapsedParents),
    [hierarchy, collapsedParents, ignoreCollapsed],
  );
  const dependencyEdges = useMemo(
    () => resolveDependencyEdges(hierarchy.tasks, hiddenInto),
    [hierarchy.tasks, hiddenInto],
  );
  // A selection only stays active while its dependency is still drawn (including rolled-up edges on
  // collapsed parents). Otherwise nothing stays dimmed or highlighted for a missing arrow.
  const activeSelectedArrow = useMemo(() => {
    if (!selectedArrow) return null;
    return dependencyEdges.some((e) => e.sourceId === selectedArrow.sourceId && e.targetId === selectedArrow.targetId)
      ? selectedArrow
      : null;
  }, [selectedArrow, dependencyEdges]);

  useEffect(() => {
    if (selectedArrow && !activeSelectedArrow) setSelectedArrow(null);
  }, [selectedArrow, activeSelectedArrow]);

  useEffect(() => {
    if (!activeSelectedArrow) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-arrow-hit-target]')) return;
      setSelectedArrow(null);
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [activeSelectedArrow]);

  const highlightedTaskIds = useMemo(() => {
    if (!activeSelectedArrow) return undefined;
    return new Set([activeSelectedArrow.sourceId, activeSelectedArrow.targetId]);
  }, [activeSelectedArrow]);
  const toggleCollapsed = useCallback((taskId: string) => {
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (!next.delete(taskId)) next.add(taskId);
      return next;
    });
  }, []);
  const collapsedSavedRef = useRef(collapsedParents);
  useEffect(() => {
    if (collapsedSavedRef.current === collapsedParents) return;
    collapsedSavedRef.current = collapsedParents;
    saveCollapsedParents(collapsedParents);
  }, [collapsedParents]);

  const { chartStart, totalDays } = useMemo(() => {
    if (!tasks.length) return { chartStart: today, totalDays: 0 };

    // If user set explicit date range, use it
    const hasDateRange = dateFrom && dateTo;

    let chartStart: Date;
    let chartEnd: Date;

    if (hasDateRange) {
      chartStart = new Date(dateFrom + 'T00:00:00');
      chartEnd = new Date(dateTo + 'T00:00:00');
    } else {
      const allDates: number[] = [today.getTime()];
      tasks.forEach((t) => {
        allDates.push(new Date(t.due + 'T00:00:00').getTime());
        if (t.startDate) allDates.push(new Date(t.startDate + 'T00:00:00').getTime());
      });
      milestones.forEach((m) => {
        if (m.targetDate) allDates.push(new Date(m.targetDate + 'T00:00:00').getTime());
      });

      const minDate = new Date(Math.min(...allDates));
      const maxDate = new Date(Math.max(...allDates));
      chartStart = new Date(minDate);
      chartStart.setDate(chartStart.getDate() - 2);
      chartEnd = new Date(maxDate);
      chartEnd.setDate(chartEnd.getDate() + 3);
    }

    // Snap the range to whole week/month columns so the timeline never starts or ends mid-cell
    if (timeScale === 'week') {
      chartStart = startOfWeek(chartStart);
    } else if (timeScale === 'month') {
      chartStart = new Date(chartStart);
      chartStart.setDate(1);
    }

    const dataDays = daysBetween(chartStart, chartEnd);

    const fixedCols = totalColumnWidth(visibleColumns, colWidths);
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth - 80 : 1200;
    const minDaysToFill = Math.ceil(Math.max(viewportWidth - fixedCols, 0) / dayWidth);
    let totalDays = Math.max(dataDays, minDaysToFill);

    if (timeScale === 'week') {
      totalDays = Math.ceil(totalDays / 7) * 7;
    } else if (timeScale === 'month') {
      const end = new Date(chartStart);
      end.setDate(end.getDate() + totalDays);
      if (end.getDate() !== 1) {
        end.setDate(1);
        end.setMonth(end.getMonth() + 1);
      }
      totalDays = daysBetween(chartStart, end);
    }

    return { chartStart, totalDays };
  }, [tasks, milestones, today, visibleColumns, colWidths, dayWidth, dateFrom, dateTo, timeScale]);

  // Calendar header (memoized): a top row of coarse groups (months, or years at month
  // scale) and a bottom row of cells matching the current time scale.
  const { topCells, bottomCells } = useMemo(() => {
    const cells = buildTimeCells(chartStart, totalDays, timeScale);

    const topCells: { label: string; days: number }[] = [];
    for (const c of cells) {
      const label =
        timeScale === 'month'
          ? String(c.start.getFullYear())
          : c.start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const last = topCells[topCells.length - 1];
      if (last && last.label === label) last.days += c.days;
      else topCells.push({ label, days: c.days });
    }

    // Company-wide days off get a header tint and the holiday name as a tooltip (day scale only)
    const companyEntries = timeScale === 'day' ? (nonWorkDays ?? []).filter((e) => !e.assigneeName) : [];

    const bottomCells = cells.map((c) => {
      const end = new Date(c.start);
      end.setDate(end.getDate() + c.days - 1);
      const iso = formatIsoDate(c.start);
      const holidays = companyEntries.filter((e) => iso >= e.startDate && iso <= e.endDate).map((e) => e.label);
      return {
        days: c.days,
        holiday: holidays.length > 0 ? holidays.join(', ') : undefined,
        isWeekend: timeScale === 'day' && isWeekend(c.start),
        isCurrent: today >= c.start && today <= end,
        label:
          timeScale === 'day'
            ? String(c.start.getDate())
            : timeScale === 'week'
              ? c.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              : c.start.toLocaleDateString('en-US', { month: 'short' }),
        sub: timeScale === 'day' ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][c.start.getDay()] : undefined,
      };
    });

    return { topCells, bottomCells };
  }, [chartStart, totalDays, today, timeScale, nonWorkDays]);

  // Milestone positions (memoized)
  const milestonesInRange = useMemo(
    () =>
      milestones
        .filter((m) => m.targetDate)
        .map((m) => {
          const mDate = new Date(m.targetDate! + 'T00:00:00');
          const dayOffset = daysBetween(chartStart, mDate);
          return { ...m, dayOffset };
        })
        .filter((m) => m.dayOffset >= 0 && m.dayOffset <= totalDays),
    [milestones, chartStart, totalDays],
  );

  // Issues per milestone — powers the drawer's progress bar and issue list
  const issuesByMilestone = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of [...tasks, ...unscheduledTasks]) {
      if (!t.milestoneId) continue;
      if (!map.has(t.milestoneId)) map.set(t.milestoneId, []);
      map.get(t.milestoneId)!.push(t);
    }
    return map;
  }, [tasks, unscheduledTasks]);

  // Drag a milestone horizontally to reschedule it; a click without movement opens the drawer.
  const handleMilestoneMouseDown = useCallback(
    (e: React.MouseEvent, milestone: Milestone & { dayOffset: number }) => {
      e.preventDefault();
      e.stopPropagation();

      const issues = issuesByMilestone.get(milestone.id) || [];

      // Read-only (no update handler): click still opens the drawer, no dragging.
      if (!onUpdateMilestoneDate) {
        openMilestonePanel(milestone, issues);
        return;
      }

      milestoneDragRef.current = { id: milestone.id, startX: e.clientX, didDrag: false };
      setMilestoneDrag({ id: milestone.id, delta: 0 });
      document.body.style.cursor = 'col-resize';

      const onMove = (ev: MouseEvent) => {
        const ref = milestoneDragRef.current;
        if (!ref) return;
        const delta = ev.clientX - ref.startX;
        if (Math.abs(delta) > 3) ref.didDrag = true;
        setMilestoneDrag({ id: ref.id, delta });
      };

      const onUp = (ev: MouseEvent) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';

        const ref = milestoneDragRef.current;
        milestoneDragRef.current = null;
        setMilestoneDrag(null);
        if (!ref) return;

        // No movement → treat as a click and open the drawer
        if (!ref.didDrag) {
          openMilestonePanel(milestone, issues);
          return;
        }

        const days = Math.round((ev.clientX - ref.startX) / dayWidth);
        if (days === 0 || !milestone.targetDate) return;

        const nd = new Date(milestone.targetDate + 'T00:00:00');
        nd.setDate(nd.getDate() + days);
        const iso = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}-${String(nd.getDate()).padStart(2, '0')}`;
        onUpdateMilestoneDate(milestone.id, iso);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [dayWidth, onUpdateMilestoneDate, issuesByMilestone],
  );

  /** Live x-offset (px) for a milestone: its date position plus any in-flight drag. */
  const milestoneX = useCallback(
    (m: { id: string; dayOffset: number }) =>
      m.dayOffset * dayWidth + dayWidth / 2 + (milestoneDrag?.id === m.id ? milestoneDrag.delta : 0),
    [dayWidth, milestoneDrag],
  );

  /** Date label shown while dragging, reflecting the snapped day offset. */
  const draggedDateLabel = useCallback(
    (m: Milestone & { dayOffset: number }) => {
      if (milestoneDrag?.id !== m.id || !m.targetDate) return null;
      const days = Math.round(milestoneDrag.delta / dayWidth);
      if (days === 0) return null;
      const d = new Date(m.targetDate + 'T00:00:00');
      d.setDate(d.getDate() + days);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    },
    [milestoneDrag, dayWidth],
  );

  const fixedColsWidth = totalColumnWidth(visibleColumns, colWidths);
  geometryRef.current = { dayWidth, fixedColsWidth, chartStartMs: chartStart.getTime() };

  // Put the anchored date back under the pointer once the new zoom has been laid out
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    zoomAnchorRef.current = null;
    const el = ganttRef.current;
    if (!el) return;
    el.scrollLeft = anchoredScrollLeft({
      anchorDayOffset: msToDayOffset(chartStart.getTime(), anchor.anchorMs),
      pointerOffsetX: anchor.pointerOffsetX,
      fixedColsWidth,
      dayWidth,
    });
  }, [dayWidth, chartStart, fixedColsWidth]);

  // Early returns — after all hooks
  if (loading) {
    return (
      <div className="h-full w-full bg-bg-primary overflow-hidden flex items-center justify-center">
        <div className="text-center text-text-secondary">
          <div className="w-10 h-10 mx-auto mb-4 border-3 border-border-primary border-t-accent rounded-full animate-spin" />
          <div className="text-sm">Fetching issues from Linear...</div>
          <p className="text-xs text-text-muted mt-1">This may take a few seconds</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full bg-bg-primary overflow-hidden flex items-center justify-center">
        <div className="text-center py-20 px-6">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-urgent/10 flex items-center justify-center">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="text-urgent"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h3 className="text-base font-semibold text-text-primary mb-2">Something went wrong</h3>
          <p className="text-sm text-text-secondary mb-1 max-w-md mx-auto">{error}</p>
          <p className="text-xs text-text-muted">
            Press <kbd className="px-1.5 py-0.5 bg-bg-hover rounded border border-border-secondary text-[10px]">R</kbd>{' '}
            to retry
          </p>
        </div>
      </div>
    );
  }

  if (!tasks.length && !unscheduledTasks.length) {
    return (
      <div className="h-full w-full bg-bg-primary overflow-auto flex items-center justify-center">
        <div className="text-center py-16 px-6">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-accent/10 flex items-center justify-center">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className="text-accent"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          </div>
          <h3 className="text-base font-semibold text-text-primary mb-2">No tasks to display</h3>
          <p className="text-sm text-text-secondary max-w-sm mx-auto mb-4">
            This could mean your current filters don't match any tasks, or the selected project has no issues yet.
          </p>
          <div className="flex items-center justify-center gap-4 text-xs text-text-muted">
            <span>Try:</span>
            <span className="px-2 py-1 bg-bg-hover rounded-md border border-border-primary">Clear filters</span>
            <span className="px-2 py-1 bg-bg-hover rounded-md border border-border-primary">Switch project</span>
          </div>
        </div>
      </div>
    );
  }

  // No scheduled tasks but some unscheduled — show a hint banner + the unscheduled list
  if (!tasks.length && unscheduledTasks.length > 0) {
    return (
      <div className="h-full w-full bg-bg-primary overflow-auto">
        <div className="max-w-2xl mx-auto py-12 px-6">
          <div className="text-center mb-8">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-accent/10 flex items-center justify-center">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                className="text-accent"
              >
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </div>
            <h3 className="text-base font-semibold text-text-primary mb-2">No issues with dates yet</h3>
            <p className="text-sm text-text-secondary max-w-md mx-auto">
              {unscheduledTasks.length} {unscheduledTasks.length === 1 ? 'issue' : 'issues'} need a due date — or add a
              target date to the project in Linear, and they'll all line up against it.
            </p>
          </div>
          <UnscheduledList tasks={unscheduledTasks} onReschedule={onReschedule} expanded />
        </div>
      </div>
    );
  }

  const thBase =
    'h-[52px] text-[11px] font-bold uppercase tracking-[0.07em] text-text-muted text-left border-b-2 border-border-primary bg-bg-header relative select-none border-r border-border-primary';

  return (
    <div
      ref={scrollContainerRef}
      onMouseDown={handleBackgroundPan}
      id="gantt-export-target"
      className="h-full w-full bg-bg-primary overflow-auto print:overflow-visible print:border-0"
    >
      <div ref={innerRef} className="relative" style={{ minWidth: '100%' }}>
        <table className="border-separate border-spacing-0" style={{ width: fixedColsWidth + totalDays * dayWidth }}>
          <thead ref={theadRef}>
            <tr>
              {visibleColumns.map((key, i) => {
                const stickyLeft = stickyColumnInfo.offsets[key];
                const isSticky = stickyLeft !== undefined;
                const isLastFrozen = key === stickyColumnInfo.lastFrozenKey;

                return (
                  <th
                    key={key}
                    data-column-key={key}
                    data-frozen={isSticky ? 'true' : undefined}
                    className={`${thBase} ${key === 'task' ? 'px-[18px]' : 'px-3'} ${
                      // Each header is its own stacking context, so the open picker menu, which is wider
                      // than the first header, needs that header lifted above the ones that follow it
                      i === 0 && pickerOpen
                        ? 'sticky top-0 z-[20]'
                        : isSticky
                          ? 'sticky top-0 z-[10]'
                          : 'sticky top-0 z-[5]'
                    } ${isLastFrozen ? 'border-r-border-secondary shadow-[2px_0_4px_-1px_rgba(0,0,0,0.2)]' : ''}`}
                    style={{
                      width: colWidths[key],
                      minWidth: getColumnDef(key).minWidth,
                      maxWidth: colWidths[key],
                      left: isSticky ? stickyLeft : undefined,
                    }}
                    onContextMenu={togglePickerFromContextMenu}
                    title={i === 0 ? 'Right-click any column header to choose columns' : undefined}
                  >
                    <span className="inline-flex items-center gap-1.5 max-w-full">
                      <span className="truncate">{getColumnDef(key).label}</span>
                      {/* Keyboard- and touch-reachable way to the same picker */}
                      {i === 0 && (
                        <ColumnPicker
                          open={pickerOpen}
                          onOpenChange={setPickerOpen}
                          visible={visibleColumns}
                          onChange={changeVisibleColumns}
                        />
                      )}
                    </span>
                    <ResizeHandle onResize={makeResizeHandler(key)} />
                  </th>
                );
              })}
              <th
                className="p-0 border-b-2 border-border-primary bg-bg-header sticky top-0 z-[5]"
                onContextMenu={togglePickerFromContextMenu}
              >
                {/* Milestone band — flags sit above the calendar and act as drag handles */}
                {milestonesInRange.length > 0 && (
                  <div
                    data-timeline-background
                    className="relative h-[24px] border-b border-border-primary/50 cursor-grab"
                  >
                    {milestonesInRange.map((m) => {
                      const dragging = milestoneDrag?.id === m.id;
                      const dateLabel = draggedDateLabel(m);
                      return (
                        <div
                          key={m.id}
                          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-1.5 h-[18px] rounded border whitespace-nowrap select-none ${
                            onUpdateMilestoneDate ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
                          } ${
                            dragging
                              ? 'bg-amber-500 border-amber-500 text-white shadow-lg'
                              : 'bg-amber-500/15 border-amber-500/50 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25'
                          }`}
                          style={{
                            left: milestoneX(m),
                            maxWidth: 180,
                            transition: dragging ? 'none' : 'background-color 150ms',
                          }}
                          onMouseDown={(e) => handleMilestoneMouseDown(e, m)}
                          title={
                            onUpdateMilestoneDate
                              ? `${m.name} — ${m.targetDate} · drag to reschedule, click for details`
                              : `${m.name} — ${m.targetDate}`
                          }
                        >
                          <span className="w-2 h-2 rotate-45 border border-current shrink-0" />
                          <span className="text-[9.5px] font-bold uppercase tracking-wide overflow-hidden text-ellipsis">
                            {dateLabel ?? m.name}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div data-timeline-background className="flex border-b border-border-primary cursor-grab">
                  {topCells.map((m, i) => (
                    <div
                      key={i}
                      className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary py-2.5 text-center border-r border-border-primary overflow-hidden whitespace-nowrap"
                      style={{ width: m.days * dayWidth }}
                    >
                      {m.label}
                    </div>
                  ))}
                </div>
                {/* The date ruler doubles as a drag surface for panning */}
                <div data-timeline-background className="flex relative cursor-grab">
                  {bottomCells.map((d, i) => (
                    <div
                      key={i}
                      className={`text-[10px] text-center py-1.5 shrink-0 border-r border-border-primary/60 overflow-hidden whitespace-nowrap ${
                        d.isCurrent
                          ? 'text-accent font-bold bg-accent/[0.08]'
                          : d.isWeekend
                            ? 'bg-bg-hover/40 text-text-muted'
                            : 'text-text-muted'
                      } ${d.holiday ? 'nonwork-company' : ''}`}
                      data-header-holiday={d.holiday}
                      title={d.holiday}
                      style={{
                        width: d.days * dayWidth,
                      }}
                    >
                      <div className="leading-none">{d.label}</div>
                      {d.sub !== undefined && (
                        <div
                          className={`text-[8px] leading-none mt-0.5 ${d.isCurrent ? 'text-accent' : 'text-text-muted/70'}`}
                        >
                          {d.sub}
                        </div>
                      )}
                    </div>
                  ))}
                  {/* Marker in the day row, aligned with the milestone's line below */}
                  {milestonesInRange.map((m) => (
                    <div
                      key={m.id}
                      className="absolute bottom-0 z-10 w-2 h-2 rotate-45 -translate-x-1/2 translate-y-1/2 border border-amber-500 bg-amber-500 pointer-events-none"
                      style={{ left: milestoneX(m) }}
                    />
                  ))}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((task) => (
              <GanttRow
                key={task.id}
                task={task}
                depth={hierarchy.depthById.get(task.id) ?? 0}
                childCount={hierarchy.childIdsById.get(task.id)?.length ?? 0}
                showTreeGutter={hierarchy.childIdsById.size > 0}
                collapsed={!ignoreCollapsed && collapsedParents.has(task.id)}
                toggleLocked={ignoreCollapsed}
                onToggleCollapse={toggleCollapsed}
                chartStart={chartStart}
                totalDays={totalDays}
                today={today}
                dayWidth={dayWidth}
                timeScale={timeScale}
                visibleColumns={visibleColumns}
                colWidths={colWidths}
                stickyOffsets={stickyColumnInfo.offsets}
                lastFrozenColumn={stickyColumnInfo.lastFrozenKey}
                projectName={projectName}
                onReschedule={onReschedule}
                onRescheduleStart={onRescheduleStart}
                onCycleStatus={onCycleStatus}
                inlineEdit={inlineEdit}
                onConnectStart={onCreateRelation ? handleConnectStart : undefined}
                isConnecting={isConnecting}
                depViolation={depViolations.get(task.id)}
                baseline={baselines?.get(task.id)}
                onReorder={onReorder}
                isExternalReadOnly={Boolean(task.isExternal && !allowExternalEdits)}
                onSelectProject={onSelectProject}
                isHighlighted={highlightedTaskIds?.has(task.id)}
                nonWorkDays={nonWorkDays}
              />
            ))}
          </tbody>
        </table>

        {/* Milestone lines — dotted verticals running down through every row.
            Purely visual (pointer-events-none) so they never intercept bar drags;
            the header flag is the drag/click handle. */}
        {milestonesInRange.map((m) => {
          const dragging = milestoneDrag?.id === m.id;
          return (
            <div
              key={m.id}
              data-milestone-line={m.id}
              className="absolute pointer-events-none z-[4]"
              style={{
                left: fixedColsWidth + milestoneX(m),
                top: headerHeight,
                bottom: 0,
                width: 0,
                borderLeft: `2px dashed ${dragging ? 'var(--color-accent)' : 'rgba(245, 158, 11, 0.75)'}`,
              }}
            />
          );
        })}

        <DependencyArrows
          edges={dependencyEdges}
          containerRef={innerRef}
          depViolations={depViolations}
          dayWidth={dayWidth}
          fixedColsWidth={fixedColsWidth}
          selectedArrow={activeSelectedArrow}
          onSelectArrow={handleSelectArrow}
        />

        {/* Connection line overlay — updated imperatively during drag for performance.
            Unlike committed arrows this stays above the bars (z-[4]): it follows the
            cursor across them and has to stay visible while you aim. */}
        <svg
          ref={connectionSvgRef}
          className="absolute top-0 left-0 pointer-events-none z-[4]"
          style={{ display: 'none', overflow: 'visible' }}
        >
          <defs>
            <marker
              id="dep-arrow-temp"
              markerUnits="userSpaceOnUse"
              markerWidth="8"
              markerHeight="6"
              refX="7"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 8 3, 0 6" fill="#7c5cfc" opacity="0.9" />
            </marker>
          </defs>
          <path
            ref={connectionPathRef}
            fill="none"
            stroke="#7c5cfc"
            strokeWidth="2"
            strokeDasharray="8 4"
            opacity="0.85"
            markerEnd="url(#dep-arrow-temp)"
          />
        </svg>
      </div>

      {/* Unscheduled tasks section */}
      {unscheduledTasks.length > 0 && (
        <div className="border-t border-border-primary print:hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-sm text-text-secondary hover:bg-bg-hover transition-colors"
            onClick={() => setUnscheduledVisible((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-text-muted shrink-0 transition-transform duration-200"
                style={{ transform: unscheduledVisible ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-high"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span className="font-medium">Unscheduled</span>
              <span className="text-xs text-text-muted bg-bg-hover rounded-full px-2 py-0.5">
                {unscheduledTasks.length}
              </span>
              <span className="text-[11px] text-text-muted ml-1">— no due date set</span>
            </div>
            <span className="text-xs text-text-muted">{unscheduledVisible ? 'Hide' : 'Show'}</span>
          </button>

          {unscheduledVisible && (
            <div className="px-4 pb-4">
              <UnscheduledList tasks={unscheduledTasks} onReschedule={onReschedule} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* Inline list component for unscheduled tasks. Each row offers quick scheduling. */
function UnscheduledList({
  tasks,
  onReschedule,
  expanded,
}: {
  tasks: Task[];
  onReschedule?: (taskUuid: string, newDueDate: string) => Promise<void>;
  expanded?: boolean;
}) {
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  return (
    <div className={`grid gap-2 ${expanded ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'}`}>
      {tasks.map((task) => (
        <UnscheduledRow key={task.uuid} task={task} todayStr={todayStr} onReschedule={onReschedule} />
      ))}
    </div>
  );
}

function UnscheduledRow({
  task,
  todayStr,
  onReschedule,
}: {
  task: Task;
  todayStr: string;
  onReschedule?: (taskUuid: string, newDueDate: string) => Promise<void>;
}) {
  const [date, setDate] = useState(todayStr);
  const [busy, setBusy] = useState(false);

  const priorityCls =
    task.priorityVal === 1
      ? 'urgent'
      : task.priorityVal === 2
        ? 'high'
        : task.priorityVal === 3
          ? 'medium'
          : task.priorityVal === 4
            ? 'low'
            : 'none';
  const idColorMap: Record<string, string> = {
    urgent: '#ef4444',
    high: '#f97316',
    medium: '#f59e0b',
    low: '#22c55e',
    none: '#a1a1aa',
  };
  const idColor = idColorMap[priorityCls];

  const schedule = useCallback(
    async (newDate: string) => {
      if (!onReschedule || busy) return;
      setBusy(true);
      try {
        await onReschedule(task.uuid, newDate);
      } finally {
        setBusy(false);
      }
    },
    [busy, onReschedule, task.uuid],
  );

  return (
    <div className="flex items-center gap-3 bg-bg-card border border-border-primary rounded-lg p-2.5 hover:border-border-secondary transition-colors">
      <Avatar name={task.assignee} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span
            className="font-mono text-[10px] tracking-[0.03em] shrink-0 px-1.5 py-0.5 rounded bg-bg-hover"
            style={{ color: idColor }}
          >
            {task.id}
          </span>
          <span className="text-[9.5px] font-semibold uppercase tracking-wide" style={{ color: idColor }}>
            {task.priority}
          </span>
          <span className="text-[10px] text-text-muted ml-auto">{task.status}</span>
        </div>
        <div className="text-[12.5px] font-medium text-text-primary leading-snug truncate">{task.title}</div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={busy || !onReschedule}
          className="bg-bg-primary border border-border-primary rounded-md text-text-primary text-xs px-2 py-1 outline-none hover:border-border-secondary focus:border-accent disabled:opacity-50"
        />
        <button
          onClick={() => schedule(date)}
          disabled={busy || !onReschedule || !date}
          className="px-2.5 py-1 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-light transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          title="Set due date"
        >
          {busy ? '…' : 'Schedule'}
        </button>
      </div>
    </div>
  );
}
