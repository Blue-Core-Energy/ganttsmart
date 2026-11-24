export interface LogoProps {
  /** Tile size in pixels (defaults to 28px, matching Tailwind w-7 h-7) */
  size?: number;
  /** Inner SVG icon size in pixels (defaults to `size`, mapping 24x24 viewBox 1:1 to the tile) */
  iconSize?: number;
  /** Additional CSS classes for the tile container */
  className?: string;
  /** Accessible label */
  'aria-label'?: string;
}

/**
 * Pure SVG mark representing GanttSmart:
 * Staggered horizontal Gantt schedule bars (descending schedule staircase)
 * that cannot be confused with left-aligned document text lines.
 */
export function LogoIcon({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      data-testid="ganttsmart-logo-svg"
    >
      {/* Three staggered horizontal Gantt bars forming a descending schedule staircase */}
      <rect x="4" y="4.5" width="9" height="3" rx="1.5" fill="white" />
      <rect x="8" y="10.5" width="9" height="3" rx="1.5" fill="white" />
      <rect x="12" y="16.5" width="8" height="3" rx="1.5" fill="white" />
    </svg>
  );
}

/**
 * Standalone presentational GanttSmart logo mark:
 * A rounded square tile in accent color (#5e6ad2) containing the staggered Gantt bars.
 */
export default function Logo({ size = 28, iconSize, className = '', 'aria-label': ariaLabel }: LogoProps) {
  const computedIconSize = iconSize ?? size;
  const sizeClass = size === 28 ? 'w-7 h-7' : size === 40 ? 'w-10 h-10' : '';
  const roundedClass = size > 32 ? 'rounded-lg' : 'rounded-md';
  const inlineStyle = size !== 28 && size !== 40 ? { width: size, height: size } : undefined;

  return (
    <div
      className={`${sizeClass} ${roundedClass} bg-accent flex items-center justify-center shrink-0 ${className}`.trim()}
      style={inlineStyle}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      data-testid="ganttsmart-logo"
    >
      <LogoIcon size={computedIconSize} />
    </div>
  );
}
