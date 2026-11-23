import { useEffect, useRef, useState } from 'react';
import type { Task } from '@/types';
import { isIgnoredTask } from '@/utils/issues';
import { loadSummaryCollapsed, saveSummaryCollapsed } from '@/utils/summaryCollapsed';
import { computeTaskStats, countUnscheduledTasks } from '@/utils/tasks';

interface Props {
  tasks: Task[];
  unscheduledTasks?: Task[];
}

function FlagIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points={up ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
    </svg>
  );
}

function buildScheduledCards(tasks: Task[]) {
  const { active, inProgress, completed, span } = computeTaskStats(tasks);
  return [
    {
      label: 'Active',
      value: active,
      color: 'var(--color-accent)',
      Icon: FlagIcon,
    },
    {
      label: 'In Progress',
      value: inProgress,
      color: 'var(--color-medium)',
      Icon: PlayIcon,
    },
    {
      label: 'Completed',
      value: completed,
      color: 'var(--color-low)',
      Icon: CheckIcon,
    },
    {
      label: 'Total Span',
      value: `${span}d`,
      color: 'var(--color-accent-light)',
      Icon: CalendarIcon,
    },
  ];
}

export default function StatsRow({ tasks, unscheduledTasks = [] }: Props) {
  const [collapsed, setCollapsed] = useState(loadSummaryCollapsed);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusToggle = useRef(false);

  // The two states render different buttons, so hand focus to the new one after a user toggle
  useEffect(() => {
    if (!focusToggle.current) return;
    focusToggle.current = false;
    toggleRef.current?.focus();
  }, [collapsed]);

  const visibleTasks = tasks.filter((t) => !isIgnoredTask(t));
  const unscheduled = countUnscheduledTasks(unscheduledTasks);
  if (!visibleTasks.length && !unscheduled) return null;

  const scheduledCards = visibleTasks.length ? buildScheduledCards(visibleTasks) : [];

  const cards = [
    ...scheduledCards,
    ...(unscheduled > 0
      ? [
          {
            label: 'Unscheduled',
            value: unscheduled,
            color: 'var(--color-high)',
            Icon: AlertIcon,
          },
        ]
      : []),
  ];

  const toggle = (next: boolean) => {
    focusToggle.current = true;
    setCollapsed(next);
    saveSummaryCollapsed(next);
  };

  if (collapsed) {
    return (
      <button
        ref={toggleRef}
        type="button"
        data-summary-toggle
        aria-expanded={false}
        onClick={() => toggle(false)}
        className="shrink-0 flex items-center gap-1.5 w-full h-6 px-4 border-b border-border-primary bg-bg-primary text-[10.5px] uppercase tracking-wider font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent transition-colors cursor-pointer print:hidden"
      >
        <ChevronIcon up={false} />
        Show summary
      </button>
    );
  }

  return (
    <div className="shrink-0 flex items-center border-b border-border-primary bg-bg-primary print:hidden">
      <div className="flex-1 min-w-0 flex items-stretch gap-0 pl-4 pr-2 py-2 overflow-x-auto">
        {cards.map((c, i) => {
          const Icon = c.Icon;
          return (
            <div
              key={c.label}
              className={`flex items-center gap-3 px-4 py-1.5 shrink-0 ${i > 0 ? 'border-l border-border-primary' : ''}`}
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                style={{ background: `color-mix(in srgb, ${c.color} 14%, transparent)`, color: c.color }}
              >
                <Icon />
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-base font-semibold text-text-primary tabular-nums">{c.value}</span>
                <span className="text-[10.5px] uppercase tracking-wider text-text-muted font-medium">{c.label}</span>
              </div>
            </div>
          );
        })}
      </div>
      <button
        ref={toggleRef}
        type="button"
        data-summary-toggle
        aria-label="Hide summary"
        aria-expanded={true}
        title="Hide summary"
        onClick={() => toggle(true)}
        className="shrink-0 self-start mt-1 mr-2 inline-flex items-center justify-center w-5 h-5 rounded text-text-muted hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors cursor-pointer"
      >
        <ChevronIcon up />
      </button>
    </div>
  );
}
