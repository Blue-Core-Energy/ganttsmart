// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedView from './SharedView';
import type { Filters, Task } from '@/types';

const mockTasks: Task[] = [
  {
    id: 'ENG-101',
    uuid: 'uuid-1',
    title: 'Design valve manifold',
    description: '',
    due: '2026-05-15',
    startDate: '2026-05-01',
    priorityVal: 2,
    priority: 'High',
    status: 'In Progress',
    statusType: 'started',
    assignee: 'Alice Smith',
    url: 'https://linear.app/test/issue/ENG-101',
    teamId: 'team-1',
    blocks: [],
    blockedBy: [],
    progress: 0,
    totalChildren: 0,
    completedChildren: 0,
  },
  {
    id: 'ENG-102',
    uuid: 'uuid-2',
    title: 'Pressure test rig',
    description: '',
    due: '2026-05-20',
    startDate: '2026-05-05',
    priorityVal: 3,
    priority: 'Medium',
    status: 'Todo',
    statusType: 'unstarted',
    assignee: 'Bob Jones',
    url: 'https://linear.app/test/issue/ENG-102',
    teamId: 'team-1',
    blocks: [],
    blockedBy: [],
    progress: 0,
    totalChildren: 0,
    completedChildren: 0,
  },
];

let mockFilters: Filters = {
  search: '',
  assignee: '',
  status: '',
  dateFrom: '',
  dateTo: '',
  showCompleted: true,
};

const setFiltersMock = vi.fn((next: Filters) => {
  mockFilters = next;
});

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}));

vi.mock('@/hooks/useSharedData', () => ({
  useSharedData: () => ({
    filteredTasks: mockTasks,
    unscheduledTasks: [],
    milestones: [],
    projectName: 'Demo Shared Roadmap',
    cachedAt: '2026-01-01T00:00:00Z',
    assignees: ['Alice Smith', 'Bob Jones'],
    statuses: ['In Progress', 'Todo'],
    loading: false,
    error: '',
    needsPassword: false,
    passwordError: '',
    submitPassword: vi.fn(),
    dayWidth: 30,
    setDayWidth: vi.fn(),
    timeScale: 'day',
    filters: mockFilters,
    setFilters: setFiltersMock,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
  }),
}));

describe('SharedView column header filtering', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mockFilters = {
      search: '',
      assignee: '',
      status: '',
      dateFrom: '',
      dateTo: '',
      showCompleted: true,
    };
    setFiltersMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it('renders header filter triggers and passes filters and dates to GanttChart', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={['/share/test-token']}>
          <SharedView />
        </MemoryRouter>,
      );
    });

    expect(container?.textContent).toContain('Demo Shared Roadmap');

    // Filter triggers are rendered in table headers
    const assigneeFilterBtn = container?.querySelector('[data-testid="column-filter-assignee"]');
    const statusFilterBtn = container?.querySelector('[data-testid="column-filter-status"]');
    const dueFilterBtn = container?.querySelector('[data-testid="column-filter-due"]');
    expect(assigneeFilterBtn).not.toBeNull();
    expect(statusFilterBtn).not.toBeNull();
    expect(dueFilterBtn).not.toBeNull();

    // Open Assignee filter popover from header
    await act(async () => {
      assigneeFilterBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const popover = document.querySelector('[data-popover="filter-assignee"]');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain('Alice Smith');
    expect(popover?.textContent).toContain('Bob Jones');

    // Select Bob Jones
    const bobOption = Array.from(popover?.querySelectorAll('button[role="option"]') ?? []).find((b) =>
      b.textContent?.includes('Bob Jones'),
    );
    expect(bobOption).toBeDefined();

    await act(async () => {
      bobOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(setFiltersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assignee: 'Bob Jones',
      }),
    );
  });

  it('renders date range popover from Due header in SharedView', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={['/share/test-token']}>
          <SharedView />
        </MemoryRouter>,
      );
    });

    const dueFilterBtn = container?.querySelector('[data-testid="column-filter-due"]');
    expect(dueFilterBtn).not.toBeNull();

    await act(async () => {
      dueFilterBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const datePopover = document.querySelector('[data-popover="date-range"]');
    expect(datePopover).not.toBeNull();
    expect(datePopover?.textContent).toContain('Date range');
  });
});
