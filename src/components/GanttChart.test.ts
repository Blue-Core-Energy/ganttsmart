import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import GanttChart from './GanttChart';
import type { Milestone, Task, Filters } from '@/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'ENG-1',
    uuid: 'uuid-1',
    title: 'Sample task',
    description: '',
    due: '2026-05-15',
    startDate: '2026-05-01',
    priorityVal: 2,
    priority: 'High',
    status: 'In Progress',
    statusType: 'started',
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

const baseMilestone: Milestone = {
  id: 'ms-1',
  name: 'Beta Release',
  description: 'Initial release',
  targetDate: '2026-05-10',
  sortOrder: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('GanttChart pinned milestone row', () => {
  const defaultProps = {
    tasks: [makeTask()],
    unscheduledTasks: [],
    milestones: [],
    loading: false,
    error: '',
    dayWidth: 30,
    timeScale: 'day' as const,
  };

  it('omits the milestone row when milestones is empty', () => {
    const html = renderToStaticMarkup(createElement(GanttChart, { ...defaultProps, milestones: [] }));
    expect(html).not.toContain('data-milestone-row');
  });

  it('renders pinned milestone row when milestones are present within chart range', () => {
    const html = renderToStaticMarkup(createElement(GanttChart, { ...defaultProps, milestones: [baseMilestone] }));
    expect(html).toContain('data-milestone-row');
    expect(html).toContain('data-milestone-diamond="ms-1"');
    expect(html).toContain('Milestones');
    expect(html).toContain('Beta Release');
  });

  it('renders read-only milestone diamonds without drag handles when onUpdateMilestoneDate is omitted', () => {
    const html = renderToStaticMarkup(createElement(GanttChart, { ...defaultProps, milestones: [baseMilestone] }));
    expect(html).toContain('data-milestone-diamond="ms-1"');
    const diamondMatch = html.match(/data-milestone-diamond="ms-1"[^>]*class="([^"]*)"/);
    expect(diamondMatch?.[1]).toContain('cursor-pointer');
    expect(diamondMatch?.[1]).not.toContain('cursor-grab');
    // Tooltip does not mention dragging
    expect(html).toContain('Beta Release — 2026-05-10');
    expect(html).not.toContain('drag to reschedule');
  });

  it('renders draggable milestone diamonds when onUpdateMilestoneDate is provided', () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const html = renderToStaticMarkup(
      createElement(GanttChart, {
        ...defaultProps,
        milestones: [baseMilestone],
        onUpdateMilestoneDate: onUpdate,
      }),
    );
    expect(html).toContain('data-milestone-diamond="ms-1"');
    const diamondMatch = html.match(/data-milestone-diamond="ms-1"[^>]*class="([^"]*)"/);
    expect(diamondMatch?.[1]).toContain('cursor-grab');
    expect(diamondMatch?.[1]).not.toContain('cursor-pointer');
    expect(html).toContain('drag to reschedule, click for details');
  });
});

function makeUnscheduledTask(id: string, uuid: string, title: string): Task {
  return {
    id,
    uuid,
    title,
    description: '',
    due: '',
    startDate: '',
    priorityVal: 4,
    priority: 'Low',
    status: 'Backlog',
    statusType: 'backlog',
    assignee: 'Bob',
    url: `https://linear.app/test/issue/${id}`,
    teamId: 'team-1',
    blocks: [],
    blockedBy: [],
    progress: 0,
    totalChildren: 0,
    completedChildren: 0,
  };
}

describe('GanttChart unscheduled section and exports', () => {
  const baseProps = {
    tasks: [makeTask()],
    unscheduledTasks: [],
    milestones: [],
    loading: false,
    error: '',
    dayWidth: 20,
  };

  it('renders unscheduled section with data-export-hide, print:hidden, and max-h-[240px] overflow-y-auto', () => {
    const unscheduledTasks = [
      makeUnscheduledTask('ENG-101', 'u-101', 'Draft architectural proposal'),
      makeUnscheduledTask('ENG-102', 'u-102', 'Order pressure test valves'),
    ];

    const html = renderToStaticMarkup(
      createElement(GanttChart, {
        ...baseProps,
        unscheduledTasks,
      }),
    );

    // Section container specifically has test id, data-export-hide, and print:hidden
    const sectionMatch = html.match(/<div[^>]*data-testid="unscheduled-section"[^>]*>/);
    expect(sectionMatch).not.toBeNull();
    expect(sectionMatch![0]).toContain('data-export-hide="true"');
    expect(sectionMatch![0]).toContain('print:hidden');

    // List container caps height and enables scrolling for long lists
    const listContainerMatch = html.match(/<div[^>]*data-testid="unscheduled-list-container"[^>]*>/);
    expect(listContainerMatch).not.toBeNull();
    expect(listContainerMatch![0]).toContain('max-h-[240px]');
    expect(listContainerMatch![0]).toContain('overflow-y-auto');

    // Shows count and tasks
    expect(html).toContain('data-testid="unscheduled-count"');
    expect(html).toContain('>2<');
    expect(html).toContain('ENG-101');
    expect(html).toContain('Draft architectural proposal');
    expect(html).toContain('ENG-102');
    expect(html).toContain('Order pressure test valves');
  });

  it('omits unscheduled section when there are no unscheduled tasks', () => {
    const html = renderToStaticMarkup(
      createElement(GanttChart, {
        ...baseProps,
        unscheduledTasks: [],
      }),
    );

    expect(html).not.toContain('data-testid="unscheduled-section"');
    expect(html).not.toContain('Unscheduled');
  });

  it('renders "No issues with dates yet" hint banner when only unscheduled tasks exist', () => {
    const unscheduledTasks = [makeUnscheduledTask('ENG-201', 'u-201', 'Task without schedule')];

    const html = renderToStaticMarkup(
      createElement(GanttChart, {
        ...baseProps,
        tasks: [],
        unscheduledTasks,
      }),
    );

    expect(html).toContain('No issues with dates yet');
    expect(html).toContain('1 issue need a due date');
    expect(html).toContain('ENG-201');
    expect(html).toContain('Task without schedule');
    // Does not render the schedule table
    expect(html).not.toContain('gantt-export-target');
    expect(html).not.toContain('<table');
  });

  it('renders "No tasks to display" when neither scheduled nor unscheduled tasks exist', () => {
    const html = renderToStaticMarkup(
      createElement(GanttChart, {
        ...baseProps,
        tasks: [],
        unscheduledTasks: [],
      }),
    );

    expect(html).toContain('No tasks to display');
    expect(html).not.toContain('<table');
  });
});

describe('GanttChart column header filters', () => {
  const baseFilters: Filters = {
    search: '',
    assignee: '',
    status: '',
    dateFrom: '',
    dateTo: '',
    showCompleted: true,
  };

  const defaultProps = {
    tasks: [makeTask()],
    unscheduledTasks: [],
    milestones: [],
    loading: false,
    error: '',
    dayWidth: 30,
    timeScale: 'day' as const,
    assignees: ['Alice', 'Bob'],
    statuses: ['In Progress', 'Done'],
  };

  it('renders filter trigger buttons on filterable columns (assignee, status, due) when filters prop is provided', () => {
    const html = renderToStaticMarkup(
      createElement(GanttChart, {
        ...defaultProps,
        filters: baseFilters,
        onFiltersChange: vi.fn(),
      }),
    );
    expect(html).toContain('data-testid="column-filter-assignee"');
    expect(html).toContain('data-testid="column-filter-status"');
    expect(html).toContain('data-testid="column-filter-due"');
    // Non-filterable columns like task and id have no filter trigger button
    expect(html).not.toContain('data-testid="column-filter-task"');
    expect(html).not.toContain('data-testid="column-filter-id"');
  });

  it('marks column as active when that column has an active filter', () => {
    const html = renderToStaticMarkup(
      createElement(GanttChart, {
        ...defaultProps,
        filters: { ...baseFilters, assignee: 'Alice' },
        onFiltersChange: vi.fn(),
      }),
    );
    const assigneeMatch = html.match(/<th[^>]*data-column-key="assignee"[^>]*>/);
    expect(assigneeMatch).not.toBeNull();
    expect(assigneeMatch![0]).toContain('data-filter-active="true"');

    const statusMatch = html.match(/<th[^>]*data-column-key="status"[^>]*>/);
    expect(statusMatch).not.toBeNull();
    expect(statusMatch![0]).not.toContain('data-filter-active="true"');
  });

  it('marks BOTH start and due columns active when date range filter is set', () => {
    const html = renderToStaticMarkup(
      createElement(GanttChart, {
        ...defaultProps,
        selectedColumns: ['task', 'start', 'due'],
        filters: { ...baseFilters, dateFrom: '2026-05-01', dateTo: '2026-05-15' },
        onFiltersChange: vi.fn(),
      }),
    );
    const startMatch = html.match(/<th[^>]*data-column-key="start"[^>]*>/);
    expect(startMatch).not.toBeNull();
    expect(startMatch![0]).toContain('data-filter-active="true"');

    const dueMatch = html.match(/<th[^>]*data-column-key="due"[^>]*>/);
    expect(dueMatch).not.toBeNull();
    expect(dueMatch![0]).toContain('data-filter-active="true"');
  });

  it('marks status column active when completed tasks are hidden', () => {
    const html = renderToStaticMarkup(
      createElement(GanttChart, {
        ...defaultProps,
        filters: { ...baseFilters, showCompleted: false },
        onFiltersChange: vi.fn(),
      }),
    );
    const statusMatch = html.match(/<th[^>]*data-column-key="status"[^>]*>/);
    expect(statusMatch).not.toBeNull();
    expect(statusMatch![0]).toContain('data-filter-active="true"');
  });

  it('renders interactive Clear filters button in empty state when filters are active', () => {
    const onFiltersChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(GanttChart, {
        ...defaultProps,
        tasks: [],
        unscheduledTasks: [],
        filters: { ...baseFilters, assignee: 'Alice' },
        onFiltersChange,
      }),
    );
    expect(html).toContain('Clear filters');
    expect(html).toContain('<button type="button" class="px-2 py-1 bg-bg-hover');
  });
});
