import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  computePopoverPosition,
  type PopoverPositionOptions,
  type PopoverPositionResult,
} from '@/utils/popoverPosition';

export interface AnchoredPopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'>, PopoverPositionOptions {
  /**
   * Ref to the anchor/trigger element that the popover is positioned against.
   * Clicks inside this element are ignored by the outside-click dismissal handler.
   */
  anchorRef: RefObject<Element | null>;

  /**
   * Optional key that triggers re-placement when changed while the popover remains open
   * (e.g. if the anchor element or its context shifts).
   */
  anchorKey?: unknown;

  /** Whether the popover is currently open (defaults to true) */
  open?: boolean;

  /**
   * Callback fired when the popover requests to close (e.g. outside click, Escape, scroll away).
   * Parameter indicates whether focus should be restored to the trigger element.
   */
  onClose: (restoreFocus?: boolean) => void;

  /** Content rendered inside the portalled popover */
  children: ReactNode;

  /** Portal target container. Defaults to document.body. */
  portalContainer?: Element | null;

  /** Whether to return focus to the anchor/trigger element on Escape dismissal (default: true) */
  restoreFocusOnClose?: boolean;

  /** Explicit element/ref to return focus to on close (overrides anchorRef) */
  returnFocusRef?: RefObject<HTMLElement | null>;

  /** Callback fired once the popover has been positioned and made visible */
  onPlaced?: (popoverElement: HTMLDivElement) => void;

  /**
   * Whether to close the popover when the anchor moves during scroll (default: true).
   * If false, the popover will re-position to track the anchor instead of closing.
   */
  closeOnScroll?: boolean;
}

function isFocusable(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected || el === document.body) return false;
  if (el.tabIndex >= 0) return true;
  if (
    el instanceof HTMLButtonElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLAnchorElement
  ) {
    return !('disabled' in el && el.disabled);
  }
  return false;
}

interface OpenPopoverEntry {
  close: (restoreFocus: boolean) => void;
  getElement: () => HTMLElement | null;
  getAnchor: () => Element | null;
}

const openPopoverStack: OpenPopoverEntry[] = [];

/**
 * Reusable portalled popover anchored to a trigger element.
 *
 * Supports:
 * - Viewport clamping & vertical flip (via computePopoverPosition)
 * - ResizeObserver re-positioning when popover or viewport resizes
 * - Outside click/press dismissal (ignoring clicks inside anchor and popover)
 * - Scroll-away dismissal with anchorRect movement gating (keeps sticky-column menus open)
 * - Escape key dismissal returning focus to trigger
 */
const AnchoredPopover = forwardRef<HTMLDivElement, AnchoredPopoverProps>(function AnchoredPopover(
  {
    anchorRef,
    anchorKey,
    open = true,
    onClose,
    children,
    viewportMargin = 8,
    gap = 4,
    align = 'start',
    placement = 'bottom',
    flip = true,
    flipHorizontal = false,
    minSpaceBelowToAvoidFlip,
    portalContainer,
    restoreFocusOnClose = true,
    returnFocusRef,
    onPlaced,
    closeOnScroll = true,
    className,
    style,
    onMouseDown,
    onClick,
    onDoubleClick,
    onKeyDown,
    ...restProps
  },
  forwardedRef,
) {
  const [position, setPosition] = useState<PopoverPositionResult | null>(null);
  const internalPopoverRef = useRef<HTMLDivElement | null>(null);
  const anchorRectRef = useRef<{ top: number; left: number } | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const placedRef = useRef(false);
  const closedRef = useRef(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const onPlacedRef = useRef(onPlaced);
  onPlacedRef.current = onPlaced;

  // Capture active element on open for focus restoration on close
  useEffect(() => {
    if (open) {
      closedRef.current = false;
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else {
      setPosition(null);
      anchorRectRef.current = null;
      placedRef.current = false;
    }
  }, [open]);

  const close = useCallback(
    (restoreFocus: boolean) => {
      if (closedRef.current) return;
      closedRef.current = true;
      onCloseRef.current(restoreFocus);
      if (restoreFocus && restoreFocusOnClose) {
        const target =
          returnFocusRef?.current ??
          (anchorRef.current instanceof HTMLElement && isFocusable(anchorRef.current)
            ? anchorRef.current
            : previousFocusRef.current);
        if (target && target.isConnected && target !== document.body) {
          target.focus();
        }
      }
    },
    [restoreFocusOnClose, returnFocusRef, anchorRef],
  );

  const reposition = useCallback(() => {
    const anchorEl = anchorRef.current;
    const popoverEl = internalPopoverRef.current;
    if (!anchorEl || !popoverEl) return;
    if (!anchorEl.isConnected) {
      close(false);
      return;
    }

    const anchorRect = anchorEl.getBoundingClientRect();
    const popoverRect = popoverEl.getBoundingClientRect();
    const clientWidth = document.documentElement.clientWidth || window.innerWidth;
    const clientHeight = document.documentElement.clientHeight || window.innerHeight;

    anchorRectRef.current = { top: anchorRect.top, left: anchorRect.left };

    const next = computePopoverPosition(
      anchorRect,
      {
        width: popoverRect.width || popoverEl.offsetWidth,
        height: popoverRect.height || popoverEl.offsetHeight,
      },
      {
        width: clientWidth,
        height: clientHeight,
      },
      {
        viewportMargin,
        gap,
        align,
        placement,
        flip,
        flipHorizontal,
        minSpaceBelowToAvoidFlip,
      },
    );

    setPosition((prev) => {
      if (
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.flipped === next.flipped &&
        prev.actualPlacement === next.actualPlacement
      ) {
        return prev;
      }
      return next;
    });
  }, [anchorRef, close, viewportMargin, gap, align, placement, flip, flipHorizontal, minSpaceBelowToAvoidFlip]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    reposition();
    window.addEventListener('resize', reposition);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reposition);
    if (internalPopoverRef.current) observer?.observe(internalPopoverRef.current);
    return () => {
      window.removeEventListener('resize', reposition);
      observer?.disconnect();
    };
  }, [open, reposition, anchorKey]);

  // Once position is resolved, trigger onPlaced callback
  useEffect(() => {
    if (!open) {
      placedRef.current = false;
      return;
    }
    if (position && !placedRef.current) {
      placedRef.current = true;
      if (internalPopoverRef.current) {
        onPlacedRef.current?.(internalPopoverRef.current);
      }
    }
  }, [open, position]);

  // Outside click, scroll movement gating, and Escape dismissal
  useEffect(() => {
    if (!open) return;

    const entry: OpenPopoverEntry = {
      close: (restoreFocus: boolean) => close(restoreFocus),
      getElement: () => internalPopoverRef.current,
      getAnchor: () => anchorRef.current,
    };
    openPopoverStack.push(entry);

    const onOutsidePress = (e: Event) => {
      const target = (e as MouseEvent | PointerEvent).target as Node | null;
      if (!target) return;
      if (internalPopoverRef.current?.contains(target) || anchorRef.current?.contains(target)) {
        return;
      }
      // If the target is inside any popover stacked above this one (or its anchor), ignore outside press
      const myIndex = openPopoverStack.lastIndexOf(entry);
      if (myIndex !== -1) {
        for (let i = myIndex + 1; i < openPopoverStack.length; i++) {
          const higher = openPopoverStack[i];
          const el = higher.getElement();
          const anchor = higher.getAnchor();
          if ((el && el.contains(target)) || (anchor && anchor.contains(target))) {
            return;
          }
        }
      }
      close(false);
    };

    const onScroll = (e: Event) => {
      if (internalPopoverRef.current?.contains(e.target as Node)) return;
      if (!closeOnScroll) {
        reposition();
        return;
      }
      // Close once the anchor has moved away from where the popover was anchored (sticky columns stay put)
      const t = anchorRef.current?.getBoundingClientRect();
      const a = anchorRectRef.current;
      if (!t || !a || Math.abs(t.top - a.top) > 1 || Math.abs(t.left - a.left) > 1) {
        close(false);
      }
    };

    const onKeyDownGlobal = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.isComposing || e.defaultPrevented) return;
      if (openPopoverStack[openPopoverStack.length - 1] !== entry) return;
      // If a nested [role="listbox"] (e.g. CustomDropdown open inside the popover) exists, let it handle Escape first
      if (internalPopoverRef.current?.querySelector('[role="listbox"]')) return;
      e.preventDefault();
      e.stopPropagation();
      entry.close(true);
    };

    document.addEventListener('pointerdown', onOutsidePress, true);
    document.addEventListener('mousedown', onOutsidePress, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKeyDownGlobal, true);

    return () => {
      const idx = openPopoverStack.lastIndexOf(entry);
      if (idx !== -1) {
        openPopoverStack.splice(idx, 1);
      }
      document.removeEventListener('pointerdown', onOutsidePress, true);
      document.removeEventListener('mousedown', onOutsidePress, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKeyDownGlobal, true);
    };
  }, [open, anchorRef, close, closeOnScroll, reposition]);

  const setMergedRefs = useCallback(
    (node: HTMLDivElement | null) => {
      internalPopoverRef.current = node;
      if (typeof forwardedRef === 'function') {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    },
    [forwardedRef],
  );

  if (!open || typeof document === 'undefined') return null;

  const targetContainer = portalContainer ?? document.body;
  if (!targetContainer) return null;

  const clientWidth = typeof document !== 'undefined' ? document.documentElement.clientWidth || window.innerWidth : 0;
  const defensiveMaxWidth = clientWidth > 0 ? Math.max(0, clientWidth - viewportMargin * 2) : undefined;
  const hasZIndex = className ? /\bz-\[?\w+\]?/.test(className) : false;
  const combinedClassName = `fixed ${hasZIndex ? '' : 'z-50'} ${className ?? ''}`.trim();

  return createPortal(
    <div
      ref={setMergedRefs}
      data-placement={position?.actualPlacement ?? placement}
      className={combinedClassName}
      style={{
        maxWidth: defensiveMaxWidth ? `${defensiveMaxWidth}px` : undefined,
        ...style,
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? (style?.visibility ?? 'visible') : 'hidden',
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onMouseDown?.(e);
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick?.(e);
      }}
      onKeyDown={onKeyDown}
      {...restProps}
    >
      {children}
    </div>,
    targetContainer,
  );
});

export default AnchoredPopover;
