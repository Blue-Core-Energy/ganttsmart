import { useCallback, useEffect, useState } from 'react';
import { registerToastHandler, type ToastItem as ToastData, type ToastType } from './toastStore';

let nextId = 0;

const ICONS: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
};

const TYPE_CLASSES: Record<ToastType, string> = {
  success: 'border-success/30 bg-success/10',
  error: 'border-urgent/30 bg-urgent/10',
  info: 'border-accent/30 bg-accent/10',
};

const ICON_CLASSES: Record<ToastType, string> = {
  success: 'bg-success text-white',
  error: 'bg-urgent text-white',
  info: 'bg-accent text-white',
};

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const addToast = useCallback((item: Omit<ToastData, 'id'>) => {
    const id = ++nextId;
    setToasts((prev) => [...prev.slice(-4), { ...item, id }]); // max 5 toasts
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    registerToastHandler(addToast);
    return () => {
      registerToastHandler(null);
    };
  }, [addToast]);

  return (
    <div className="fixed bottom-6 right-6 z-[250] flex flex-col gap-2 pointer-events-none print:hidden">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => removeToast(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast: t, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, t.type === 'error' ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [onDismiss, t.type]);

  return (
    <div
      className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm max-w-[380px] animate-slide-in ${TYPE_CLASSES[t.type]}`}
      style={{ animation: 'slide-in 0.2s ease-out' }}
    >
      <span
        className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${ICON_CLASSES[t.type]}`}
      >
        {ICONS[t.type]}
      </span>
      <span className="text-xs text-text-primary flex-1">{t.message}</span>
      {t.action && (
        <button
          onClick={() => {
            t.action!.onClick();
            onDismiss();
          }}
          className="text-[11px] font-semibold text-accent hover:text-accent/80 cursor-pointer shrink-0"
        >
          {t.action.label}
        </button>
      )}
      <button
        onClick={onDismiss}
        className="text-text-muted hover:text-text-secondary cursor-pointer shrink-0 text-sm leading-none"
      >
        ×
      </button>
    </div>
  );
}
