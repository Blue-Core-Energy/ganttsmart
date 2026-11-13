import type { TaskBaseline } from '@/hooks/usePlanningHistory';
import type { Task } from '@/types';

let globalOpenPanel: ((task: Task) => void) | null = null;
let globalClosePanel: (() => void) | null = null;
let globalRemoveRelation: ((sourceId: string, targetId: string) => Promise<void>) | null = null;
let globalBaselines: Map<string, TaskBaseline> = new Map();

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
