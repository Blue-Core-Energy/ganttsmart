import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskBaseline } from '@/backend/types';
import type { Task } from '@/types';
import { DEFAULT_COLUMN_WIDTHS, DEFAULT_VISIBLE_COLUMNS } from '@/utils/scheduleColumns';
import GanttRow from './GanttRow';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'ENG-1',
    uuid: 'uuid-1',
    title: 'Baseline Test Task',
    description: '',
    due: '2026-05-15',
    startDate: '2026-05-05',
    priorityVal: 2,
    priority: 'High',
    status: 'Todo',
    statusType: 'unstarted',
    assignee: 'Alice',
    url: 'https://linear.app/test/issue/ENG-1',
    teamId: 'team-1',
    blocks: [],
    blockedBy: [],
    progress: 0,
    totalChildren: 0,
    completedChildren: 0,
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<TaskBaseline> = {}): TaskBaseline {
  return {
    issue_id: 'ENG-1',
    planned_start: '2026-05-05',
    planned_due: '2026-05-15',
    first_seen_at: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

const defaultProps = {
  chartStart: new Date('2026-05-01T00:00:00'),
  totalDays: 30,
  today: new Date('2026-05-10T00:00:00'),
  dayWidth: 20,
  visibleColumns: DEFAULT_VISIBLE_COLUMNS,
  colWidths: DEFAULT_COLUMN_WIDTHS,
};

describe('GanttRow - Plan vs Actual baseline ghost overlay', () => {
  it('does not render baseline ghost when dates have not drifted', () => {
    const task = makeTask({ startDate: '2026-05-05', due: '2026-05-15' });
    const baseline = makeBaseline({
      planned_start: '2026-05-05',
      planned_due: '2026-05-15',
    });

    const html = renderToStaticMarkup(
      createElement(GanttRow, {
        ...defaultProps,
        task,
        baseline,
      }),
    );

    expect(html).not.toContain('data-baseline-bar');
    expect(html).not.toContain('baseline-ghost-bar');
  });

  it('renders neutral baseline ghost when dates have drifted', () => {
    const task = makeTask({ startDate: '2026-05-08', due: '2026-05-18' });
    const baseline = makeBaseline({
      planned_start: '2026-05-05',
      planned_due: '2026-05-15',
    });

    const html = renderToStaticMarkup(
      createElement(GanttRow, {
        ...defaultProps,
        task,
        baseline,
      }),
    );

    expect(html).toContain('data-baseline-bar="ENG-1"');
    expect(html).toContain('baseline-ghost-bar');
    expect(html).toContain('Originally planned: 2026-05-05 → 2026-05-15');
    // Must NOT contain the old amber classes or inline amber backgrounds
    expect(html).not.toContain('border-amber-400');
    expect(html).not.toContain('rgba(251, 191, 36');
  });

  it('does not render baseline ghost when the task is completed', () => {
    const task = makeTask({
      startDate: '2026-05-08',
      due: '2026-05-18',
      status: 'Done',
      statusType: 'completed',
    });
    const baseline = makeBaseline({
      planned_start: '2026-05-05',
      planned_due: '2026-05-15',
    });

    const html = renderToStaticMarkup(
      createElement(GanttRow, {
        ...defaultProps,
        task,
        baseline,
      }),
    );

    expect(html).not.toContain('data-baseline-bar');
  });
});
