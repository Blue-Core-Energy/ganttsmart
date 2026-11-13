export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  action?: { label: string; onClick: () => void };
}

let globalAddToast: ((item: Omit<ToastItem, 'id'>) => void) | null = null;

export function registerToastHandler(handler: ((item: Omit<ToastItem, 'id'>) => void) | null): void {
  globalAddToast = handler;
}

export function toast(message: string, type: ToastType = 'info', action?: ToastItem['action']): void {
  globalAddToast?.({ message, type, action });
}

export function toastError(message: string, retry?: () => void): void {
  toast(message, 'error', retry ? { label: 'Retry', onClick: retry } : undefined);
}

export function toastSuccess(message: string): void {
  toast(message, 'success');
}
