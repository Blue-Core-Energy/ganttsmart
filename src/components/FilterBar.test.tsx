// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilterBar from './FilterBar';
import type { Filters } from '@/types';

describe('FilterBar', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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

  const baseFilters: Filters = {
    search: '',
    assignee: '',
    status: '',
    dateFrom: '',
    dateTo: '',
    showCompleted: true,
  };

  it('renders search input and omits separate Filter button on desktop', async () => {
    await act(async () => {
      root?.render(
        <FilterBar
          assignees={['Alice', 'Bob']}
          statuses={['In Progress', 'Done']}
          filters={baseFilters}
          onFiltersChange={vi.fn()}
          isNarrow={false}
        />,
      );
    });

    expect(container?.querySelector('input[placeholder="Search tasks…"]')).not.toBeNull();
    // Desktop does not render separate Filter button
    const buttons = Array.from(container?.querySelectorAll('button') ?? []);
    const filterBtn = buttons.find((b) => b.textContent?.trim() === 'Filter');
    expect(filterBtn).toBeUndefined();
  });

  it('renders compact Completed toggle on desktop when status column is hidden', async () => {
    const onFiltersChange = vi.fn();

    await act(async () => {
      root?.render(
        <FilterBar
          assignees={['Alice']}
          statuses={['Done']}
          filters={baseFilters}
          onFiltersChange={onFiltersChange}
          statusColumnHidden={true}
          isNarrow={false}
        />,
      );
    });

    const completedBtn = Array.from(container?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent?.trim() === 'Completed',
    );
    expect(completedBtn).toBeDefined();

    await act(async () => {
      completedBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onFiltersChange).toHaveBeenCalledWith({
      ...baseFilters,
      showCompleted: false,
    });
  });

  it('renders compact Filter button on narrow viewport (< 768px)', async () => {
    const onFiltersChange = vi.fn();

    await act(async () => {
      root?.render(
        <FilterBar
          assignees={['Alice']}
          statuses={['Done']}
          filters={{ ...baseFilters, assignee: 'Alice' }}
          onFiltersChange={onFiltersChange}
          isNarrow={true}
        />,
      );
    });

    const buttons = Array.from(container?.querySelectorAll('button') ?? []);
    const filterBtn = buttons.find((b) => b.textContent?.includes('Filter'));
    expect(filterBtn).toBeDefined();
    expect(filterBtn?.textContent).toContain('1'); // Badge count

    // Click Filter button to open mobile filter popover
    await act(async () => {
      filterBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const popover = document.querySelector('[role="group"][aria-label="Filters"]');
    expect(popover).not.toBeNull();
  });

  it('renders active filter chips and resets all filters on Clear all', async () => {
    const onFiltersChange = vi.fn();
    const activeFilters: Filters = {
      search: 'test',
      assignee: 'Alice',
      status: 'Done',
      dateFrom: '2026-05-01',
      dateTo: '2026-05-15',
      showCompleted: false,
    };

    await act(async () => {
      root?.render(
        <FilterBar
          assignees={['Alice']}
          statuses={['Done']}
          filters={activeFilters}
          onFiltersChange={onFiltersChange}
          isNarrow={false}
        />,
      );
    });

    expect(container?.textContent).toContain('"test"');
    expect(container?.textContent).toContain('Alice');
    expect(container?.textContent).toContain('Done');
    expect(container?.textContent).toContain('2026-05-01 → 2026-05-15');
    expect(container?.textContent).toContain('Completed hidden');

    const clearAllBtn = Array.from(container?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent?.trim() === 'Clear all',
    );
    expect(clearAllBtn).toBeDefined();

    await act(async () => {
      clearAllBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onFiltersChange).toHaveBeenCalledWith({
      search: '',
      assignee: '',
      status: '',
      dateFrom: '',
      dateTo: '',
      showCompleted: true,
    });
  });

  it('keeps mobile Filter panel open when interacting with nested DateRangePicker', async () => {
    const onFiltersChange = vi.fn();

    await act(async () => {
      root?.render(
        <FilterBar
          assignees={['Alice']}
          statuses={['Done']}
          filters={baseFilters}
          onFiltersChange={onFiltersChange}
          isNarrow={true}
        />,
      );
    });

    // Open mobile filter panel
    const filterBtn = Array.from(container?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Filter'),
    );
    await act(async () => {
      filterBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const mobilePanel = document.querySelector('[role="group"][aria-label="Filters"]');
    expect(mobilePanel).not.toBeNull();

    // Open nested DateRangePicker inside mobile filter panel
    const dateRangeBtn = Array.from(mobilePanel?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Date range'),
    );
    expect(dateRangeBtn).toBeDefined();
    await act(async () => {
      dateRangeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const datePopover = document.querySelector('[data-popover="date-range"]');
    expect(datePopover).not.toBeNull();

    // Clicking inside the nested DateRangePicker popover should NOT close the outer mobile filter panel
    await act(async () => {
      datePopover?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(document.querySelector('[role="group"][aria-label="Filters"]')).not.toBeNull();
  });

  it('closes nested dropdown on Escape without closing the mobile Filter panel', async () => {
    const onFiltersChange = vi.fn();

    await act(async () => {
      root?.render(
        <FilterBar
          assignees={['Alice']}
          statuses={['Done']}
          filters={baseFilters}
          onFiltersChange={onFiltersChange}
          isNarrow={true}
        />,
      );
    });

    // Open mobile filter panel
    const filterBtn = Array.from(container?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Filter'),
    );
    await act(async () => {
      filterBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const mobilePanel = document.querySelector('[role="group"][aria-label="Filters"]');
    expect(mobilePanel).not.toBeNull();

    // Open Assignee dropdown inside mobile filter panel
    const assigneeBtn = Array.from(mobilePanel?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Any assignee'),
    );
    expect(assigneeBtn).toBeDefined();
    await act(async () => {
      assigneeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    // Press Escape — should close the dropdown (role="listbox") while keeping the mobile Filter panel open
    await act(async () => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[role="group"][aria-label="Filters"]')).not.toBeNull();

    // A second Escape now closes the mobile Filter panel
    await act(async () => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(document.querySelector('[role="group"][aria-label="Filters"]')).toBeNull();
  });

  it('resolves custom status names in FilterBar using statusTypeByStatus', async () => {
    const onFiltersChange = vi.fn();

    await act(async () => {
      root?.render(
        <FilterBar
          assignees={[]}
          statuses={['In Review']}
          statusTypeByStatus={new Map([['In Review', 'started']])}
          filters={baseFilters}
          onFiltersChange={onFiltersChange}
          isNarrow={true}
        />,
      );
    });

    // Open mobile filter panel
    const filterBtn = Array.from(container?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Filter'),
    );
    await act(async () => {
      filterBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Open Status dropdown
    const statusDropdown = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Any status'),
    );
    await act(async () => {
      statusDropdown?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const option = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.includes('In Review'),
    );
    expect(option).toBeDefined();
    // In progress / started icon has a path element for the half fill
    expect(option?.querySelector('path')).not.toBeNull();
  });
});
