import type { Task } from '@/types';

export interface TooltipState {
  task: Task | null;
  x: number;
  y: number;
}

type TooltipSetter = (s: TooltipState | ((prev: TooltipState) => TooltipState)) => void;

let globalTooltipSetter: TooltipSetter | null = null;

export function registerTooltipSetter(setter: TooltipSetter | null): void {
  globalTooltipSetter = setter;
}

export function showTooltip(task: Task, x: number, y: number): void {
  globalTooltipSetter?.({ task, x, y });
}

export function hideTooltip(): void {
  globalTooltipSetter?.({ task: null, x: 0, y: 0 });
}
