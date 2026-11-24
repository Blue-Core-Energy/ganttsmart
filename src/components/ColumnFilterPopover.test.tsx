// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ColumnFilterPopover from './ColumnFilterPopover';
import type { Filters } from '@/types';

describe('ColumnFilterPopover', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let anchorEl: HTMLButtonElement | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    anchorEl = document.createElement('button');
    document.body.appendChild(anchorEl);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    anchorEl?.remove();
    anchorEl = null;
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

  it('renders Assignee filter popover and selects an assignee', async () => {
    const onFiltersChange = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        <ColumnFilterPopover
          columnKey="assignee"
          anchorRef={{ current: anchorEl }}
          onClose={onClose}
          filters={baseFilters}
          onFiltersChange={onFiltersChange}
          assignees={['Alice Smith', 'Bob Jones']}
          statuses={[]}
        />,
      );
    });

    const popover = document.querySelector('[data-popover="filter-assignee"]');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain('Alice Smith');
    expect(popover?.textContent).toContain('Bob Jones');

    const bobButton = Array.from(popover?.querySelectorAll('button[role="option"]') ?? []).find((b) =>
      b.textContent?.includes('Bob Jones'),
    );
    expect(bobButton).toBeDefined();

    await act(async () => {
      bobButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onFiltersChange).toHaveBeenCalledWith({
      ...baseFilters,
      assignee: 'Bob Jones',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('clears active assignee filter when Clear is clicked', async () => {
    const onFiltersChange = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        <ColumnFilterPopover
          columnKey="assignee"
          anchorRef={{ current: anchorEl }}
          onClose={onClose}
          filters={{ ...baseFilters, assignee: 'Alice Smith' }}
          onFiltersChange={onFiltersChange}
          assignees={['Alice Smith', 'Bob Jones']}
          statuses={[]}
        />,
      );
    });

    const clearBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Clear');
    expect(clearBtn).toBeDefined();

    await act(async () => {
      clearBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onFiltersChange).toHaveBeenCalledWith({
      ...baseFilters,
      assignee: '',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders Status filter popover, selects status, and toggles Completed', async () => {
    const onFiltersChange = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        <ColumnFilterPopover
          columnKey="status"
          anchorRef={{ current: anchorEl }}
          onClose={onClose}
          filters={baseFilters}
          onFiltersChange={onFiltersChange}
          assignees={[]}
          statuses={['In Progress', 'Done', 'Backlog']}
        />,
      );
    });

    const popover = document.querySelector('[data-popover="filter-status"]');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain('In Progress');
    expect(popover?.textContent).toContain('Completed tasks');

    // Select Done
    const doneOption = Array.from(popover?.querySelectorAll('button[role="option"]') ?? []).find((b) =>
      b.textContent?.includes('Done'),
    );
    await act(async () => {
      doneOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onFiltersChange).toHaveBeenCalledWith({
      ...baseFilters,
      status: 'Done',
    });

    // Toggle completed
    const completedBtn = Array.from(popover?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('Completed tasks'),
    );
    await act(async () => {
      completedBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onFiltersChange).toHaveBeenCalledWith({
      ...baseFilters,
      showCompleted: false,
    });
  });

  it('renders Date Range filter popover and clears active range', async () => {
    const onFiltersChange = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        <ColumnFilterPopover
          columnKey="due"
          anchorRef={{ current: anchorEl }}
          onClose={onClose}
          filters={{ ...baseFilters, dateFrom: '2026-05-01', dateTo: '2026-05-15' }}
          onFiltersChange={onFiltersChange}
          assignees={[]}
          statuses={[]}
        />,
      );
    });

    const popover = document.querySelector('[data-popover="date-range"]');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toContain('Date range');

    const clearBtn = Array.from(popover?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent?.trim() === 'Clear',
    );
    expect(clearBtn).toBeDefined();

    await act(async () => {
      clearBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onFiltersChange).toHaveBeenCalledWith({
      ...baseFilters,
      dateFrom: '',
      dateTo: '',
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('disables Apply button in Date Range popover until both from and to dates are selected', async () => {
    await act(async () => {
      root?.render(
        <ColumnFilterPopover
          columnKey="due"
          anchorRef={{ current: anchorEl }}
          onClose={vi.fn()}
          filters={baseFilters}
          onFiltersChange={vi.fn()}
          assignees={[]}
          statuses={[]}
        />,
      );
    });

    const popover = document.querySelector('[data-popover="date-range"]');
    const applyBtn = Array.from(popover?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent?.trim() === 'Apply',
    );
    expect(applyBtn).toBeDefined();
    expect(applyBtn?.hasAttribute('disabled')).toBe(true);
  });
});
