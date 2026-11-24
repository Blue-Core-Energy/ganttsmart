import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  },
}));

import { DebounceCancelled } from '@/api/linear';
import { useLinearData } from './useLinearData';
import type { Task, WorkflowState } from '@/types';

const mockLinear = vi.hoisted(() => ({
  fetchProjects: vi.fn(),
  fetchIssues: vi.fn(),
  fetchWorkflowStates: vi.fn(),
  fetchAssignableUsers: vi.fn(),
  fetchProjectExternalLinks: vi.fn(),
  createProjectExternalLink: vi.fn(),
  updateIssueDueDate: vi.fn(),
  updateIssueStartDate: vi.fn(),
  updateIssueSchedule: vi.fn(),
  updateMilestoneTargetDate: vi.fn(),
  updateIssueState: vi.fn(),
  updateIssueAssignee: vi.fn(),
  updateIssueTitle: vi.fn(),
  createIssueRelation: vi.fn(),
  removeIssueRelation: vi.fn(),
}));

vi.mock('@/api/linear', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/linear')>();
  return {
    ...actual,
    fetchProjects: mockLinear.fetchProjects,
    fetchIssues: mockLinear.fetchIssues,
    fetchWorkflowStates: mockLinear.fetchWorkflowStates,
    fetchAssignableUsers: mockLinear.fetchAssignableUsers,
    fetchProjectExternalLinks: mockLinear.fetchProjectExternalLinks,
    createProjectExternalLink: mockLinear.createProjectExternalLink,
    updateIssueDueDate: mockLinear.updateIssueDueDate,
    updateIssueStartDate: mockLinear.updateIssueStartDate,
    updateIssueSchedule: mockLinear.updateIssueSchedule,
    updateMilestoneTargetDate: mockLinear.updateMilestoneTargetDate,
    updateIssueState: mockLinear.updateIssueState,
    updateIssueAssignee: mockLinear.updateIssueAssignee,
    updateIssueTitle: mockLinear.updateIssueTitle,
    createIssueRelation: mockLinear.createIssueRelation,
    removeIssueRelation: mockLinear.removeIssueRelation,
  };
});

const toastMocks = vi.hoisted(() => {
  const toasts: Array<{ message: string; type: string; action?: { label: string; onClick?: () => void } }> = [];
  return {
    toasts,
    toast: vi.fn((message: string, type = 'info', action?: { label: string; onClick?: () => void }) => {
      toasts.push({ message, type, action });
    }),
    toastError: vi.fn((message: string, retry?: () => void) => {
      toasts.push({ message, type: 'error', action: retry ? { label: 'Retry', onClick: retry } : undefined });
    }),
    toastSuccess: vi.fn((message: string, action?: { label: string; onClick?: () => void }) => {
      toasts.push({ message, type: 'success', action });
    }),
    clear: () => {
      toasts.length = 0;
    },
  };
});

vi.mock('@/components/toastStore', () => ({
  toast: toastMocks.toast,
  toastError: toastMocks.toastError,
  toastSuccess: toastMocks.toastSuccess,
}));

interface MockElement {
  tagName: string;
  nodeType: number;
  style: Record<string, string>;
  setAttribute: (k: string, v: string) => void;
  removeAttribute: (k: string) => void;
  getAttribute: (k: string) => string | null;
  childNodes: unknown[];
  appendChild: <T>(child: T) => T;
  removeChild: <T>(child: T) => T;
  addEventListener: () => void;
  removeEventListener: () => void;
  ownerDocument: unknown;
  parentNode?: unknown;
}

let keydownListener: ((e: unknown) => void) | null = null;
let visibilityListener: (() => void) | null = null;

function setupDom() {
  keydownListener = null;
  visibilityListener = null;
  const windowStub = {
    location: { origin: 'http://localhost:3000', href: 'http://localhost:3000/', search: '' },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    HTMLIFrameElement: class HTMLIFrameElement {},
  };

  const documentStub = {
    visibilityState: 'visible',
    createElement: (tag: string): MockElement => {
      const el: MockElement = {
        tagName: tag.toUpperCase(),
        nodeType: 1,
        style: {},
        setAttribute: () => {},
        removeAttribute: () => {},
        getAttribute: () => null,
        childNodes: [],
        appendChild: <T>(child: T): T => {
          el.childNodes.push(child);
          return child;
        },
        removeChild: <T>(child: T): T => {
          const i = el.childNodes.indexOf(child);
          if (i >= 0) el.childNodes.splice(i, 1);
          return child;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        ownerDocument: documentStub,
      };
      return el;
    },
    createTextNode: (text: string) => ({ nodeType: 3, nodeValue: text }),
    addEventListener: vi.fn((event: string, handler: (e: unknown) => void) => {
      if (event === 'keydown') keydownListener = handler;
      if (event === 'visibilitychange') visibilityListener = handler as () => void;
    }),
    removeEventListener: vi.fn((event: string) => {
      if (event === 'keydown') keydownListener = null;
      if (event === 'visibilitychange') visibilityListener = null;
    }),
    defaultView: windowStub,
  };

  vi.stubGlobal('window', windowStub);
  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'ENG-1',
    uuid: 'u-1',
    title: 'Task 1',
    description: '',
    due: '2026-03-05',
    startDate: '2026-03-01',
    assignee: 'Alice',
    assigneeId: 'user-1',
    status: 'Todo',
    statusType: 'unstarted',
    priorityVal: 3,
    priority: 'Normal',
    url: 'https://linear.app/issue/ENG-1',
    teamId: 'team-1',
    blocks: [],
    blockedBy: [],
    progress: 0,
    totalChildren: 0,
    completedChildren: 0,
    ...overrides,
  };
}

const mockWorkflowStates: WorkflowState[] = [
  { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 'st-in-progress', name: 'In Progress', type: 'started', position: 1 },
  { id: 'st-done', name: 'Done', type: 'completed', position: 2 },
];

const activeUnmounts: Array<() => Promise<void>> = [];

async function renderHook<T>(hook: () => T): Promise<{ result: { current: T }; unmount: () => Promise<void> }> {
  const result = { current: undefined as unknown as T };
  const container = document.createElement('div');
  const root = createRoot(container as unknown as HTMLElement);

  function Component() {
    result.current = hook();
    return null;
  }

  await act(async () => {
    root.render(createElement(Component));
  });

  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
  };
  activeUnmounts.push(unmount);

  return {
    result,
    unmount,
  };
}

describe('useLinearData unified mutations and undo', () => {
  beforeEach(() => {
    setupDom();
    toastMocks.clear();
    vi.clearAllMocks();

    mockLinear.fetchProjects.mockResolvedValue([{ id: 'proj-1', name: 'Project Alpha' }]);
    mockLinear.fetchProjectExternalLinks.mockResolvedValue({ url: null, externalLinks: [] });
    mockLinear.fetchWorkflowStates.mockResolvedValue(mockWorkflowStates);
    mockLinear.fetchAssignableUsers.mockResolvedValue([
      { id: 'user-1', name: 'Alice', displayName: 'Alice A' },
      { id: 'user-2', name: 'Bob', displayName: 'Bob B' },
    ]);
    mockLinear.updateIssueDueDate.mockResolvedValue(undefined);
    mockLinear.updateIssueStartDate.mockResolvedValue(undefined);
    mockLinear.updateIssueSchedule.mockResolvedValue(undefined);
    mockLinear.updateIssueState.mockResolvedValue(undefined);
    mockLinear.updateIssueAssignee.mockResolvedValue(undefined);
    mockLinear.updateIssueTitle.mockResolvedValue(undefined);
    mockLinear.createIssueRelation.mockResolvedValue(undefined);
    mockLinear.removeIssueRelation.mockResolvedValue(undefined);
    mockLinear.updateMilestoneTargetDate.mockResolvedValue(undefined);

    mockLinear.fetchIssues.mockResolvedValue({
      tasks: [
        makeTask({ id: 'ENG-1', uuid: 'u-1', title: 'Task 1', due: '2026-03-05', startDate: '2026-03-01' }),
        makeTask({
          id: 'ENG-2',
          uuid: 'u-2',
          title: 'Task 2',
          due: '2026-03-06',
          startDate: '2026-03-02',
          assignee: 'Bob',
          assigneeId: 'user-2',
          status: 'In Progress',
          statusType: 'started',
        }),
      ],
      unscheduledTasks: [makeTask({ id: 'ENG-3', uuid: 'u-3', title: 'Task 3', due: '', startDate: null })],
      externalTasks: [],
      externalUnscheduledTasks: [],
      projectName: 'Project Alpha',
      milestones: [{ id: 'm-1', name: 'Alpha Milestone', targetDate: '2026-03-20' }],
    });
  });

  afterEach(async () => {
    await Promise.all(activeUnmounts.map((u) => u()));
    activeUnmounts.length = 0;
    vi.unstubAllGlobals();
  });

  it('persists Ctrl+Z revert back to Linear and reports toastSuccess', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    // Reschedule Task 1
    let success = false;
    await act(async () => {
      success = await result.current.reschedule('u-1', '2026-03-10');
    });
    expect(success).toBe(true);
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-10');
    expect(mockLinear.updateIssueDueDate).toHaveBeenCalledWith('token-123', 'u-1', '2026-03-10');

    // Press Ctrl+Z via undo()
    let undone = false;
    await act(async () => {
      undone = await result.current.undo();
    });
    expect(undone).toBe(true);
    // Task 1 reverted locally
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
    // Linear revert was persisted
    expect(mockLinear.updateIssueDueDate).toHaveBeenCalledWith('token-123', 'u-1', '2026-03-05');
    // Toast success announced
    expect(toastMocks.toastSuccess).toHaveBeenCalledWith('Undone: ENG-1 due date');
  });

  it('handles Ctrl+Z persist failure cleanly with rollback to forward state and toastError', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    // Reschedule Task 1
    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });

    // Make the revert API call fail
    mockLinear.updateIssueDueDate.mockRejectedValueOnce(new Error('Linear API 500'));

    let undone = false;
    await act(async () => {
      undone = await result.current.undo();
    });
    expect(undone).toBe(false);
    // Rolled back to forward state
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-10');
    expect(toastMocks.toastError).toHaveBeenCalledWith('Failed to undo ENG-1 due date: Linear API 500');
  });

  it('coordinates toast Undo button with Ctrl+Z stack to avoid double-undo', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });

    // Find the toast with Undo button
    const toastItem = toastMocks.toasts.find((t) => t.action?.label === 'Undo');
    expect(toastItem).toBeDefined();

    // Click toast Undo button
    await act(async () => {
      toastItem?.action?.onClick?.();
    });

    // Locally reverted and persisted to Linear
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
    expect(mockLinear.updateIssueDueDate).toHaveBeenCalledWith('token-123', 'u-1', '2026-03-05');
    // Toast click does not show extra "Undone: ..." toast
    expect(toastMocks.toastSuccess).not.toHaveBeenCalledWith('Undone: ENG-1 due date');

    // Calling undo() now should be a no-op because the entry was already consumed
    mockLinear.updateIssueDueDate.mockClear();
    let secondUndo = false;
    await act(async () => {
      secondUndo = await result.current.undo();
    });
    expect(secondUndo).toBe(false);
    expect(mockLinear.updateIssueDueDate).not.toHaveBeenCalled();
  });

  it('disables leftover toast Undo button if already undone via Ctrl+Z', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });

    const toastItem = toastMocks.toasts.find((t) => t.action?.label === 'Undo');
    expect(toastItem).toBeDefined();

    // Undo first via Ctrl+Z
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
    expect(mockLinear.updateIssueDueDate).toHaveBeenCalledWith('token-123', 'u-1', '2026-03-05');

    // Now click the toast Undo button that was already on screen
    mockLinear.updateIssueDueDate.mockClear();
    await act(async () => {
      toastItem?.action?.onClick?.();
    });
    // Must NOT fire another Linear mutation
    expect(mockLinear.updateIssueDueDate).not.toHaveBeenCalled();
  });

  it('triggers undo via keyboard Ctrl+Z event listener', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });

    expect(keydownListener).not.toBeNull();
    const preventDefault = vi.fn();
    await act(async () => {
      keydownListener?.({
        ctrlKey: true,
        key: 'z',
        shiftKey: false,
        target: { tagName: 'DIV' },
        preventDefault,
      });
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
    expect(mockLinear.updateIssueDueDate).toHaveBeenCalledWith('token-123', 'u-1', '2026-03-05');
  });

  it('preserves concurrent edits on other rows during field-level failure rollback', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    // Make Task 1 update reject
    mockLinear.updateIssueDueDate.mockRejectedValueOnce(new Error('Network offline'));

    // Reschedule Task 1 (fails)
    let success = false;
    await act(async () => {
      success = await result.current.reschedule('u-1', '2026-03-10');
    });
    expect(success).toBe(false);
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');

    // Mutate Task 2 title
    await act(async () => {
      await result.current.renameTask('u-2', 'Updated Task 2 Title');
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-2')?.title).toBe('Updated Task 2 Title');

    // Now if Task 1 fails another mutation, Task 2's title must NOT be clobbered
    mockLinear.updateIssueStartDate.mockRejectedValueOnce(new Error('Start update failed'));
    await act(async () => {
      await result.current.rescheduleStart('u-1', '2026-03-03');
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.startDate).toBe('2026-03-01');
    expect(result.current.tasks.find((t) => t.uuid === 'u-2')?.title).toBe('Updated Task 2 Title');
  });

  it('preserves concurrent edits on other rows during Ctrl+Z undo', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    // Reschedule Task 1
    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });

    // Concurrently edit Task 2 assignee
    await act(async () => {
      await result.current.setTaskAssignee('u-2', { id: 'user-1', name: 'Alice', displayName: 'Alice A' });
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-2')?.assignee).toBe('Alice');

    // Now undo Task 2 (assignee)
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-2')?.assignee).toBe('Bob');
    // Task 1 is still in its updated state
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-10');

    // Next undo reverts Task 1
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
    // Task 2 is still Bob
    expect(result.current.tasks.find((t) => t.uuid === 'u-2')?.assignee).toBe('Bob');
  });

  it('supports createRelation and persists removeIssueRelation on undo', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    await act(async () => {
      await result.current.createRelation('ENG-1', 'ENG-2');
    });

    expect(mockLinear.createIssueRelation).toHaveBeenCalledWith('token-123', 'u-1', 'u-2');
    expect(result.current.tasks.find((t) => t.id === 'ENG-1')?.blocks).toContain('ENG-2');
    expect(result.current.tasks.find((t) => t.id === 'ENG-2')?.blockedBy).toContain('ENG-1');

    // Undo via Ctrl+Z persists removeIssueRelation
    await act(async () => {
      await result.current.undo();
    });

    expect(mockLinear.removeIssueRelation).toHaveBeenCalledWith('token-123', 'u-1', 'u-2');
    expect(result.current.tasks.find((t) => t.id === 'ENG-1')?.blocks).not.toContain('ENG-2');
    expect(result.current.tasks.find((t) => t.id === 'ENG-2')?.blockedBy).not.toContain('ENG-1');
  });

  it('supports removeRelation and persists createIssueRelation on undo', async () => {
    // Start with existing relation
    mockLinear.fetchIssues.mockResolvedValueOnce({
      tasks: [
        makeTask({ id: 'ENG-1', uuid: 'u-1', blocks: ['ENG-2'], blockedBy: [] }),
        makeTask({ id: 'ENG-2', uuid: 'u-2', blocks: [], blockedBy: ['ENG-1'] }),
      ],
      unscheduledTasks: [],
      externalTasks: [],
      externalUnscheduledTasks: [],
      projectName: 'Project Alpha',
      milestones: [],
    });

    const { result } = await renderHook(() => useLinearData('token-123'));

    await act(async () => {
      await result.current.removeRelation('ENG-1', 'ENG-2');
    });

    expect(mockLinear.removeIssueRelation).toHaveBeenCalledWith('token-123', 'u-1', 'u-2');
    expect(result.current.tasks.find((t) => t.id === 'ENG-1')?.blocks).toEqual([]);
    expect(result.current.tasks.find((t) => t.id === 'ENG-2')?.blockedBy).toEqual([]);

    // Undo via Ctrl+Z persists createIssueRelation
    await act(async () => {
      await result.current.undo();
    });

    expect(mockLinear.createIssueRelation).toHaveBeenCalledWith('token-123', 'u-1', 'u-2');
    expect(result.current.tasks.find((t) => t.id === 'ENG-1')?.blocks).toContain('ENG-2');
    expect(result.current.tasks.find((t) => t.id === 'ENG-2')?.blockedBy).toContain('ENG-1');
  });

  it('promotes unscheduled task and demotes it on undo or rollback', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    expect(result.current.unscheduledTasks.some((t) => t.uuid === 'u-3')).toBe(true);
    expect(result.current.tasks.some((t) => t.uuid === 'u-3')).toBe(false);

    // Reschedule Task 3
    await act(async () => {
      await result.current.reschedule('u-3', '2026-03-12');
    });

    expect(result.current.unscheduledTasks.some((t) => t.uuid === 'u-3')).toBe(false);
    expect(result.current.tasks.find((t) => t.uuid === 'u-3')?.due).toBe('2026-03-12');

    // Undo demotes Task 3 back to unscheduled
    await act(async () => {
      await result.current.undo();
    });

    expect(result.current.tasks.some((t) => t.uuid === 'u-3')).toBe(false);
    expect(result.current.unscheduledTasks.find((t) => t.uuid === 'u-3')?.due).toBe('');
    // Scheduled tasks are intact
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
  });

  it('handles DebounceCancelled without rolling back or showing toastError', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    mockLinear.updateIssueDueDate.mockRejectedValueOnce(new DebounceCancelled());

    let success = true;
    await act(async () => {
      success = await result.current.reschedule('u-1', '2026-03-15');
    });

    expect(success).toBe(false);
    // Did NOT rollback optimistic date
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-15');
    // Did NOT show error toast
    expect(toastMocks.toastError).not.toHaveBeenCalled();
  });

  it('validates date ordering and returns false on error', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    // Due date before start date
    let resDue = true;
    await act(async () => {
      resDue = await result.current.reschedule('u-1', '2026-02-20');
    });
    expect(resDue).toBe(false);
    expect(toastMocks.toastError).toHaveBeenCalledWith('Due date cannot be before start date');

    // Start date after due date
    let resStart = true;
    await act(async () => {
      resStart = await result.current.rescheduleStart('u-1', '2026-03-20');
    });
    expect(resStart).toBe(false);
    expect(toastMocks.toastError).toHaveBeenCalledWith('Start date cannot be after due date');

    // Range with start after due
    let resRange = true;
    await act(async () => {
      resRange = await result.current.rescheduleRange('u-1', '2026-03-10', '2026-03-15');
    });
    expect(resRange).toBe(false);
    expect(toastMocks.toastError).toHaveBeenCalledWith('Start date cannot be after due date');
  });

  it('supports updateMilestoneDate and undo', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    await act(async () => {
      await result.current.updateMilestoneDate('m-1', '2026-03-25');
    });

    expect(result.current.milestones.find((m) => m.id === 'm-1')?.targetDate).toBe('2026-03-25');
    expect(mockLinear.updateMilestoneTargetDate).toHaveBeenCalledWith('token-123', 'm-1', '2026-03-25');

    // Undo via Ctrl+Z
    await act(async () => {
      await result.current.undo();
    });

    expect(result.current.milestones.find((m) => m.id === 'm-1')?.targetDate).toBe('2026-03-20');
    expect(mockLinear.updateMilestoneTargetDate).toHaveBeenCalledWith('token-123', 'm-1', '2026-03-20');
  });

  it('supports rescheduleStart and rescheduleRange undo persistence to Linear', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    // Reschedule start
    await act(async () => {
      await result.current.rescheduleStart('u-1', '2026-03-03');
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.startDate).toBe('2026-03-03');
    expect(mockLinear.updateIssueStartDate).toHaveBeenCalledWith('token-123', 'u-1', '2026-03-03');

    // Undo start
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.startDate).toBe('2026-03-01');
    expect(mockLinear.updateIssueStartDate).toHaveBeenCalledWith('token-123', 'u-1', '2026-03-01');

    // Reschedule range
    await act(async () => {
      await result.current.rescheduleRange('u-1', '2026-03-12', '2026-03-04');
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-12');
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.startDate).toBe('2026-03-04');
    expect(mockLinear.updateIssueSchedule).toHaveBeenCalledWith('token-123', 'u-1', {
      dueDate: '2026-03-12',
      startDate: '2026-03-04',
    });

    // Undo range
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.startDate).toBe('2026-03-01');
    expect(mockLinear.updateIssueSchedule).toHaveBeenCalledWith('token-123', 'u-1', {
      dueDate: '2026-03-05',
      startDate: '2026-03-01',
    });
  });

  it('supports setTaskStatus and renameTask undo persistence to Linear', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    // Status change
    const doneState = mockWorkflowStates.find((s) => s.id === 'st-done')!;
    await act(async () => {
      await result.current.setTaskStatus('u-1', doneState);
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.status).toBe('Done');
    expect(mockLinear.updateIssueState).toHaveBeenCalledWith('token-123', 'u-1', 'st-done');

    // Undo status
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.status).toBe('Todo');
    expect(mockLinear.updateIssueState).toHaveBeenCalledWith('token-123', 'u-1', 'st-todo');

    // Rename task
    await act(async () => {
      await result.current.renameTask('u-1', 'Refactored Task 1');
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.title).toBe('Refactored Task 1');
    expect(mockLinear.updateIssueTitle).toHaveBeenCalledWith('token-123', 'u-1', 'Refactored Task 1');

    // Undo rename
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.title).toBe('Task 1');
    expect(mockLinear.updateIssueTitle).toHaveBeenCalledWith('token-123', 'u-1', 'Task 1');
  });

  it('clears undo stack on project switch', async () => {
    mockLinear.fetchProjects.mockResolvedValue([
      { id: 'proj-1', name: 'Project Alpha' },
      { id: 'proj-2', name: 'Project Beta' },
    ]);
    const { result } = await renderHook(() => useLinearData('token-123'));

    // Perform mutation on proj-1
    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });

    // Switch to proj-2
    await act(async () => {
      result.current.selectProject('proj-2');
    });

    // Attempt undo: should be empty / no-op
    mockLinear.updateIssueDueDate.mockClear();
    let undone = false;
    await act(async () => {
      undone = await result.current.undo();
    });
    expect(undone).toBe(false);
    expect(mockLinear.updateIssueDueDate).not.toHaveBeenCalled();
  });

  it('handles rapid Ctrl+Z DebounceCancelled inside undo without rolling back or error toast', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });

    // Reverting dueDate throws DebounceCancelled (e.g. rapid double undo within 300ms)
    mockLinear.updateIssueDueDate.mockRejectedValueOnce(new DebounceCancelled());

    let undone = true;
    await act(async () => {
      undone = await result.current.undo();
    });

    expect(undone).toBe(false);
    // Did NOT roll back local optimistic revert
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
    // Did NOT show toastError
    expect(toastMocks.toastError).not.toHaveBeenCalled();
  });

  it('atomically reverts snapTasksToDaysOff on a 1-day task via updateIssueSchedule', async () => {
    mockLinear.fetchIssues.mockResolvedValueOnce({
      tasks: [makeTask({ id: 'ENG-1', uuid: 'u-1', startDate: '2026-03-02', due: '2026-03-02' })],
      unscheduledTasks: [],
      externalTasks: [],
      externalUnscheduledTasks: [],
      projectName: 'Project Alpha',
      milestones: [],
    });

    const { result } = await renderHook(() => useLinearData('token-123'));

    const holiday = {
      id: 'd-1',
      label: 'Holiday',
      startDate: '2026-03-02',
      endDate: '2026-03-02',
      assigneeName: null,
    };
    await act(async () => {
      await result.current.snapTasksToDaysOff([holiday], holiday);
    });

    // Undo the snap
    await act(async () => {
      await result.current.undo();
    });

    // Must call updateIssueSchedule with both startDate and dueDate together
    expect(mockLinear.updateIssueSchedule).toHaveBeenCalledWith('token-123', 'u-1', {
      dueDate: '2026-03-02',
      startDate: '2026-03-02',
    });
  });

  it('preserves concurrent edits on other rows during true in-flight deferred-promise failure', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    let rejectTask1!: (e: Error) => void;
    mockLinear.updateIssueDueDate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectTask1 = reject;
        }),
    );

    // Start reschedule on Task 1 (in flight)
    let p1: Promise<boolean>;
    act(() => {
      p1 = result.current.reschedule('u-1', '2026-03-10');
    });

    // Concurrently edit Task 2 title while Task 1 is pending
    await act(async () => {
      await result.current.renameTask('u-2', 'Concurrent Title Edit');
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-2')?.title).toBe('Concurrent Title Edit');

    // Reject Task 1
    await act(async () => {
      rejectTask1(new Error('Deferred network error'));
      await p1;
    });

    // Task 1 rolled back
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
    // Task 2 title remains intact
    expect(result.current.tasks.find((t) => t.uuid === 'u-2')?.title).toBe('Concurrent Title Edit');
  });

  it('preserves same-task concurrent different-field edit during in-flight undo', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });

    let resolveUndo!: () => void;
    mockLinear.updateIssueDueDate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUndo = () => resolve();
        }),
    );

    // Start undo for due date (in flight)
    let undoPromise: Promise<boolean>;
    act(() => {
      undoPromise = result.current.undo();
    });

    // Concurrently edit title on Task 1 while undo is in flight
    await act(async () => {
      await result.current.renameTask('u-1', 'Title during in-flight undo');
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.title).toBe('Title during in-flight undo');

    // Resolve undo revert
    await act(async () => {
      resolveUndo();
      await undoPromise;
    });

    // Due date was reverted to 2026-03-05
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
    // Title is still preserved!
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.title).toBe('Title during in-flight undo');
  });

  it('does NOT promote unscheduled tasks in rescheduleStart', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    expect(result.current.unscheduledTasks.some((t) => t.uuid === 'u-3')).toBe(true);
    expect(result.current.tasks.some((t) => t.uuid === 'u-3')).toBe(false);

    await act(async () => {
      await result.current.rescheduleStart('u-3', '2026-03-01');
    });

    // Task 3 must remain in unscheduledTasks
    expect(result.current.unscheduledTasks.some((t) => t.uuid === 'u-3')).toBe(true);
    expect(result.current.tasks.some((t) => t.uuid === 'u-3')).toBe(false);
    expect(result.current.unscheduledTasks.find((t) => t.uuid === 'u-3')?.startDate).toBe('2026-03-01');
  });

  it('clears dueDate: null on Linear when undoing unscheduled task promotion', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    // Promote Task 3
    await act(async () => {
      await result.current.reschedule('u-3', '2026-03-12');
    });
    expect(result.current.tasks.some((t) => t.uuid === 'u-3')).toBe(true);

    // Undo promotion
    await act(async () => {
      await result.current.undo();
    });

    // Task 3 demoted back to unscheduled
    expect(result.current.unscheduledTasks.some((t) => t.uuid === 'u-3')).toBe(true);
    expect(result.current.tasks.some((t) => t.uuid === 'u-3')).toBe(false);
    // Linear dueDate cleared via null
    expect(mockLinear.updateIssueDueDate).toHaveBeenCalledWith('token-123', 'u-3', null);
  });

  it('handles out-of-order toast Undo stack coordination by ignoring superseded edit', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    // Edit 1: change due date to 2026-03-10
    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });
    const toast1 = toastMocks.toasts[toastMocks.toasts.length - 1];

    // Edit 2: change due date to 2026-03-15
    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-15');
    });

    // Click Toast 1's Undo (superseded by Edit 2)
    mockLinear.updateIssueDueDate.mockClear();
    await act(async () => {
      toast1.action?.onClick?.();
    });

    // Must be ignored (superseded), task stays 2026-03-15
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-15');
    expect(mockLinear.updateIssueDueDate).not.toHaveBeenCalled();

    // Now Ctrl+Z correctly undoes Edit 2 back to 2026-03-10
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-10');
    expect(mockLinear.updateIssueDueDate).toHaveBeenCalledWith('token-123', 'u-1', '2026-03-10');
  });

  it('forwards authentication expired error to onAuthError', async () => {
    const onAuthError = vi.fn();
    const { result } = await renderHook(() => useLinearData('token-123', onAuthError));

    mockLinear.updateIssueDueDate.mockRejectedValueOnce(new Error('Linear authentication expired'));

    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });

    expect(onAuthError).toHaveBeenCalled();
    expect(toastMocks.toastError).toHaveBeenCalledWith('Linear session expired. Reconnecting...');
  });

  it('guards against project switch mid-flight in mutateTaskField', async () => {
    mockLinear.fetchProjects.mockResolvedValue([
      { id: 'proj-1', name: 'Project Alpha' },
      { id: 'proj-2', name: 'Project Beta' },
    ]);
    const { result } = await renderHook(() => useLinearData('token-123'));

    let resolveMutation!: () => void;
    mockLinear.updateIssueDueDate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveMutation = () => resolve();
        }),
    );

    // Reschedule on proj-1 in flight
    let resPromise: Promise<boolean>;
    act(() => {
      resPromise = result.current.reschedule('u-1', '2026-03-10');
    });

    // Switch to proj-2
    await act(async () => {
      result.current.selectProject('proj-2');
    });

    // Mutation finishes
    let res = true;
    await act(async () => {
      resolveMutation();
      res = await resPromise;
    });

    // Discarded because project switched mid-flight
    expect(res).toBe(false);
  });

  it('skips silentRefresh state update when undo is in flight', async () => {
    const { result } = await renderHook(() => useLinearData('token-123'));

    await act(async () => {
      await result.current.reschedule('u-1', '2026-03-10');
    });

    let resolveUndo!: () => void;
    mockLinear.updateIssueDueDate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUndo = () => resolve();
        }),
    );

    // Start undo in flight
    let undoPromise: Promise<boolean>;
    act(() => {
      undoPromise = result.current.undo();
    });

    // While undo is in flight, mock fetchIssues returning stale data from server
    mockLinear.fetchIssues.mockResolvedValueOnce({
      tasks: [makeTask({ id: 'ENG-1', uuid: 'u-1', due: '2026-03-10' })],
      unscheduledTasks: [],
      externalTasks: [],
      externalUnscheduledTasks: [],
      projectName: 'Project Alpha',
      milestones: [],
    });

    // While undo is in flight, trigger silentRefresh via visibilitychange
    expect(visibilityListener).not.toBeNull();
    mockLinear.fetchIssues.mockClear();
    await act(async () => {
      visibilityListener?.();
    });

    // silentRefresh bailed out early because pendingMutations > 0
    expect(mockLinear.fetchIssues).not.toHaveBeenCalled();

    // Complete undo
    await act(async () => {
      resolveUndo();
      await undoPromise;
    });

    // State correctly reflects the undone revert (2026-03-05)
    expect(result.current.tasks.find((t) => t.uuid === 'u-1')?.due).toBe('2026-03-05');
  });
});
