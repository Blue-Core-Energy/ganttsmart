import type { Milestone, Task } from '@/types';

let globalOpenPanel: ((milestone: Milestone, issues: Task[]) => void) | null = null;
let globalClosePanel: (() => void) | null = null;
let globalUpdateDate: ((milestoneId: string, targetDate: string) => Promise<void>) | null = null;

export function registerMilestonePanelHandlers(
  open: ((milestone: Milestone, issues: Task[]) => void) | null,
  close: (() => void) | null,
): void {
  globalOpenPanel = open;
  globalClosePanel = close;
}

export function openMilestonePanel(milestone: Milestone, issues: Task[] = []): void {
  globalOpenPanel?.(milestone, issues);
}

export function closeMilestonePanel(): void {
  globalClosePanel?.();
}

/** Register the handler used by the panel's date picker. Pass null for read-only views. */
export function setMilestoneDateHandler(
  handler: ((milestoneId: string, targetDate: string) => Promise<void>) | null,
): void {
  globalUpdateDate = handler;
}

export function getMilestoneDateHandler(): ((milestoneId: string, targetDate: string) => Promise<void>) | null {
  return globalUpdateDate;
}
