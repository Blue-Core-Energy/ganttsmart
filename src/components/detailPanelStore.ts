import type { TaskBaseline } from '@/hooks/usePlanningHistory';
import type { Task } from '@/types';

let globalOpenPanel: ((task: Task) => void) | null = null;
let globalClosePanel: (() => void) | null = null;
let globalRemoveRelation: ((sourceId: string, targetId: string) => Promise<void>) | null = null;
let globalBaselines: Map<string, TaskBaseline> = new Map();
let globalTaskMap: Map<string, Task> = new Map();
let globalSelectProject: ((projectId: string) => void) | null = null;
let globalAllowExternalEdits = false;
let globalToggleExternalEdits: ((allow: boolean) => void) | null = null;
const contextListeners = new Set<() => void>();

function notifyContextListeners() {
  for (const listener of contextListeners) listener();
}

export function subscribeDetailPanelContext(listener: () => void): () => void {
  contextListeners.add(listener);
  return () => contextListeners.delete(listener);
}

export function registerDetailPanelHandlers(open: ((task: Task) => void) | null, close: (() => void) | null): void {
  globalOpenPanel = open;
  globalClosePanel = close;
}

export function setBaselinesForPanel(baselines: Map<string, TaskBaseline>): void {
  globalBaselines = baselines;
}

export function getDetailPanelBaselines(): Map<string, TaskBaseline> {
  return globalBaselines;
}

export function setDetailPanelTaskMap(tasks: Task[]): void {
  const map = new Map<string, Task>();
  for (const t of tasks) {
    map.set(t.id, t);
  }
  globalTaskMap = map;
  notifyContextListeners();
}

export function getDetailPanelTask(id: string): Task | undefined {
  return globalTaskMap.get(id);
}

export function setDetailPanelProjectSelectHandler(handler: ((projectId: string) => void) | null): void {
  globalSelectProject = handler;
  notifyContextListeners();
}

export function getDetailPanelProjectSelectHandler(): ((projectId: string) => void) | null {
  return globalSelectProject;
}

export function setDetailPanelExternalEditState(allow: boolean, toggle: ((allow: boolean) => void) | null): void {
  globalAllowExternalEdits = allow;
  globalToggleExternalEdits = toggle;
  notifyContextListeners();
}

export function getDetailPanelExternalEditState(): {
  allowExternalEdits: boolean;
  onToggleExternalEdits: ((allow: boolean) => void) | null;
} {
  return {
    allowExternalEdits: globalAllowExternalEdits,
    onToggleExternalEdits: globalToggleExternalEdits,
  };
}

export function openDetailPanel(task: Task): void {
  globalOpenPanel?.(task);
}

export function closeDetailPanel(): void {
  globalClosePanel?.();
}

export function setRemoveRelationHandler(
  handler: ((sourceId: string, targetId: string) => Promise<void>) | null,
): void {
  globalRemoveRelation = handler;
}

export function getRemoveRelationHandler(): ((sourceId: string, targetId: string) => Promise<void>) | null {
  return globalRemoveRelation;
}
