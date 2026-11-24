import type { ReactElement } from 'react';

export interface PriorityIconProps {
  priority: string | number;
  size?: number;
  className?: string;
  color?: string;
}

export function PriorityIcon({ priority, size = 14, className = '', color }: PriorityIconProps): ReactElement {
  const norm = typeof priority === 'number' ? priority : (priority || '').trim().toLowerCase();

  // Urgent: 1 or 'urgent' -> orange/red square with exclamation mark inside
  if (norm === 1 || norm === 'urgent') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="currentColor"
        className={`shrink-0 ${className}`.trim()}
        style={color ? { color } : undefined}
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M2.5 1.5A1.5 1.5 0 001 3v10a1.5 1.5 0 001.5 1.5h11a1.5 1.5 0 001.5-1.5V3a1.5 1.5 0 00-1.5-1.5h-11zm5.5 3a.75.75 0 01.75.75v4a.75.75 0 01-1.5 0v-4A.75.75 0 018 4.5zm0 7.5a.875.875 0 100-1.75.875.875 0 000 1.75z"
        />
      </svg>
    );
  }

  // High: 2 or 'high' -> 3 bars all filled
  if (norm === 2 || norm === 'high') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="currentColor"
        className={`shrink-0 ${className}`.trim()}
        style={color ? { color } : undefined}
        aria-hidden="true"
      >
        <rect x="2" y="10" width="3" height="4" rx="0.75" />
        <rect x="6.5" y="6" width="3" height="8" rx="0.75" />
        <rect x="11" y="2" width="3" height="12" rx="0.75" />
      </svg>
    );
  }

  // Medium: 3 or 'medium' -> 2 bars filled, 1 muted
  if (norm === 3 || norm === 'medium') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="currentColor"
        className={`shrink-0 ${className}`.trim()}
        style={color ? { color } : undefined}
        aria-hidden="true"
      >
        <rect x="2" y="10" width="3" height="4" rx="0.75" />
        <rect x="6.5" y="6" width="3" height="8" rx="0.75" />
        <rect x="11" y="2" width="3" height="12" rx="0.75" opacity="0.25" />
      </svg>
    );
  }

  // Low: 4 or 'low' -> 1 bar filled, 2 muted
  if (norm === 4 || norm === 'low') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="currentColor"
        className={`shrink-0 ${className}`.trim()}
        style={color ? { color } : undefined}
        aria-hidden="true"
      >
        <rect x="2" y="10" width="3" height="4" rx="0.75" />
        <rect x="6.5" y="6" width="3" height="8" rx="0.75" opacity="0.25" />
        <rect x="11" y="2" width="3" height="12" rx="0.75" opacity="0.25" />
      </svg>
    );
  }

  // None: 0 or 'none' / default -> 3 horizontal dashes/dots
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={`shrink-0 ${className}`.trim()}
      style={color ? { color } : undefined}
      aria-hidden="true"
    >
      <rect x="2" y="7" width="3" height="2" rx="0.5" opacity="0.4" />
      <rect x="6.5" y="7" width="3" height="2" rx="0.5" opacity="0.4" />
      <rect x="11" y="7" width="3" height="2" rx="0.5" opacity="0.4" />
    </svg>
  );
}

export default PriorityIcon;
