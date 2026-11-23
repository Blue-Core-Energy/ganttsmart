import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import GanttChart from './GanttChart';
import type { Milestone, Task } from '@/types';

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
