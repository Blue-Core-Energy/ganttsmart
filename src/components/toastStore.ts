export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
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

export function toastSuccess(message: string, action?: ToastItem['action']): void {
  toast(message, 'success', action);
}
