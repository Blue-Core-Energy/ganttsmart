import type { ReactElement } from 'react';

export interface StatusIconProps {
  type?: string;
  color?: string;
  size?: number;
  className?: string;
}

export function StatusIcon({ type = 'unstarted', color, size = 14, className = '' }: StatusIconProps): ReactElement {
  const normalized = (type || '').trim().toLowerCase();

  // Completed / Done
  if (normalized === 'completed' || normalized === 'done') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={`shrink-0 ${className}`.trim()}
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6.75" fill={color || 'var(--color-success)'} />
        <path
          d="M5.2 8.2L7.2 10.2L11 5.8"
          stroke="#ffffff"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // In Progress / Started
  if (normalized === 'started' || normalized === 'in_progress' || normalized === 'in progress') {
    const strokeColor = color || 'var(--color-accent)';
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={`shrink-0 ${className}`.trim()}
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6" stroke={strokeColor} strokeWidth="1.5" />
        <path d="M8 2A6 6 0 0 1 8 14Z" fill={strokeColor} />
      </svg>
    );
  }

  // Backlog
  if (normalized === 'backlog') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={`shrink-0 ${className}`.trim()}
        aria-hidden="true"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          stroke={color || 'var(--color-text-muted)'}
          strokeWidth="1.5"
          strokeDasharray="2.5 2.5"
        />
      </svg>
    );
  }

  // Canceled
  if (normalized === 'canceled' || normalized === 'cancelled') {
    const c = color || 'var(--color-text-muted)';
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={`shrink-0 ${className}`.trim()}
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6" stroke={c} strokeWidth="1.5" />
        <line x1="5.5" y1="5.5" x2="10.5" y2="10.5" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
        <line x1="10.5" y1="5.5" x2="5.5" y2="10.5" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  // Duplicate
  if (normalized === 'duplicate') {
    const c = color || 'var(--color-text-muted)';
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={`shrink-0 ${className}`.trim()}
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6" stroke={c} strokeWidth="1.5" />
        <line x1="4.5" y1="11.5" x2="11.5" y2="4.5" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  // Triage
  if (normalized === 'triage') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={`shrink-0 ${className}`.trim()}
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6" stroke={color || 'var(--color-medium)'} strokeWidth="1.5" strokeDasharray="1.5 2" />
      </svg>
    );
  }

  // Default / Unstarted / Todo
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={`shrink-0 ${className}`.trim()}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" stroke={color || 'var(--color-text-muted)'} strokeWidth="1.5" />
    </svg>
  );
}

export default StatusIcon;
