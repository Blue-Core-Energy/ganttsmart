export interface AnchorRect {
  top: number;
  left: number;
  bottom?: number;
  right?: number;
  width?: number;
  height?: number;
}

export interface PopoverDimensions {
  width: number;
  height: number;
}

export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface PopoverPositionOptions {
  /** Distance kept from all viewport edges in pixels (default: 8) */
  viewportMargin?: number;
  /** Gap between anchor and popover in pixels (default: 4) */
  gap?: number;
  /** Horizontal alignment relative to anchor: 'start' aligns left edges, 'end' aligns right edges (default: 'start') */
  align?: 'start' | 'end';
  /** Preferred vertical placement: 'bottom' or 'top' (default: 'bottom') */
  placement?: 'bottom' | 'top';
  /** Whether to flip vertically when there is not enough room (default: true) */
  flip?: boolean;
  /** Whether to flip horizontal alignment when it overflows the viewport edge (default: false) */
  flipHorizontal?: boolean;
  /**
   * If provided, flip vertically when space below is less than this threshold and space above > space below.
   * If omitted, popover height is used.
   */
  minSpaceBelowToAvoidFlip?: number;
}

export interface PopoverPositionResult {
  top: number;
  left: number;
  bottom?: number;
  flipped: boolean;
  actualPlacement: 'top' | 'bottom';
}

/**
 * Computes pure positioning coordinates (top, left, and optional bottom) for a popover
 * anchored to an element, with viewport boundary clamping and vertical/horizontal flip logic.
 */
export function computePopoverPosition(
  anchor: AnchorRect,
  popover: PopoverDimensions,
  viewport: ViewportDimensions,
  options?: PopoverPositionOptions,
): PopoverPositionResult {
  const margin = Math.max(0, options?.viewportMargin ?? 8);
  const gap = Math.max(0, options?.gap ?? 4);
  const align = options?.align ?? 'start';
  const placement = options?.placement ?? 'bottom';
  const flip = options?.flip ?? true;
  const flipHorizontal = options?.flipHorizontal ?? false;

  const vpWidth = Math.max(0, viewport.width);
  const vpHeight = Math.max(0, viewport.height);

  const popWidth = Math.max(0, popover.width);
  const popHeight = Math.max(0, popover.height);

  const anchorTop = anchor.top;
  const anchorLeft = anchor.left;
  const anchorBottom = anchor.bottom !== undefined ? anchor.bottom : anchorTop + (anchor.height ?? 0);
  const anchorRight = anchor.right !== undefined ? anchor.right : anchorLeft + (anchor.width ?? 0);

  // Horizontal calculation and clamping
  const minLeft = margin;
  const maxLeft = Math.max(margin, vpWidth - popWidth - margin);

  let effectiveAlign = align;
  if (flipHorizontal) {
    if (align === 'start') {
      if (anchorLeft + popWidth > vpWidth - margin && anchorRight - popWidth >= margin) {
        effectiveAlign = 'end';
      }
    } else if (align === 'end') {
      if (anchorRight - popWidth < margin && anchorLeft + popWidth <= vpWidth - margin) {
        effectiveAlign = 'start';
      }
    }
  }

  const idealLeft = effectiveAlign === 'end' ? anchorRight - popWidth : anchorLeft;
  const left = Math.round(Math.max(minLeft, Math.min(idealLeft, maxLeft)));

  // Vertical calculation
  const spaceBelow = vpHeight - anchorBottom - margin;
  const spaceAbove = anchorTop - margin;

  let flipped = false;

  if (placement === 'bottom') {
    if (flip) {
      const thresholdBelow =
        options?.minSpaceBelowToAvoidFlip !== undefined ? options.minSpaceBelowToAvoidFlip : popHeight + gap;
      const shouldFlip = spaceBelow < thresholdBelow && spaceAbove > spaceBelow;
      if (shouldFlip) {
        flipped = true;
      }
    }
  } else {
    // placement === 'top'
    if (flip) {
      const thresholdAbove = popHeight + gap;
      const shouldFlip = spaceAbove < thresholdAbove && spaceBelow > spaceAbove;
      if (shouldFlip) {
        flipped = true;
      }
    }
  }

  const isBelow = (placement === 'bottom' && !flipped) || (placement === 'top' && flipped);
  const actualPlacement: 'top' | 'bottom' = isBelow ? 'bottom' : 'top';

  let top: number;
  let bottom: number | undefined;

  if (isBelow) {
    top = anchorBottom + gap;
    top = Math.max(margin, top);
  } else {
    top = anchorTop - gap - popHeight;
    top = Math.max(margin, top);
    bottom = vpHeight - anchorTop + gap;
  }

  return {
    top: Math.round(top),
    left,
    bottom: bottom !== undefined ? Math.round(bottom) : undefined,
    flipped,
    actualPlacement,
  };
}
