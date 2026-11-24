// @vitest-environment happy-dom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AnchoredPopover, { type AnchoredPopoverProps } from './AnchoredPopover';

describe('AnchoredPopover', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  function TestHarness({
    popoverProps,
    initialAnchorRect = { top: 100, left: 100, bottom: 130, right: 180, width: 80, height: 30 },
  }: {
    popoverProps?: Partial<AnchoredPopoverProps>;
    initialAnchorRect?: { top: number; left: number; bottom: number; right: number; width: number; height: number };
  }) {
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [anchorRect, setAnchorRect] = useState(initialAnchorRect);

    return (
      <div>
        <button
          ref={(el) => {
            triggerRef.current = el;
            if (el) {
              el.getBoundingClientRect = () => anchorRect as DOMRect;
            }
          }}
          type="button"
          id="trigger-btn"
        >
          Open Popover
        </button>
        <button
          type="button"
          id="move-anchor-btn"
          onClick={() => {
            setAnchorRect((prev) => ({ ...prev, top: prev.top + 50, bottom: prev.bottom + 50 }));
          }}
        >
          Move Anchor
        </button>
        <AnchoredPopover
          anchorRef={triggerRef}
          open={true}
          onClose={vi.fn()}
          data-testid="test-popover"
          {...popoverProps}
        >
          <div data-testid="popover-content">
            <button type="button" id="inside-btn">
              Inside button
            </button>
          </div>
        </AnchoredPopover>
      </div>
    );
  }

  it('portals content into document.body by default', async () => {
    await act(async () => {
      root!.render(<TestHarness />);
    });

    const popover = document.body.querySelector('[data-testid="test-popover"]');
    expect(popover).not.toBeNull();
    expect(popover?.parentElement).toBe(document.body);
    expect(popover?.className).toContain('fixed');
    expect(document.body.querySelector('[data-testid="popover-content"]')).not.toBeNull();
  });

  it('portals into a custom portalContainer if provided', async () => {
    const customContainer = document.createElement('div');
    customContainer.id = 'custom-portal-target';
    document.body.appendChild(customContainer);

    try {
      await act(async () => {
        root!.render(<TestHarness popoverProps={{ portalContainer: customContainer }} />);
      });

      const popover = customContainer.querySelector('[data-testid="test-popover"]');
      expect(popover).not.toBeNull();
      expect(popover?.parentElement).toBe(customContainer);
    } finally {
      customContainer.remove();
    }
  });

  it('dismisses on outside click, but ignores clicks on anchor and inside popover', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root!.render(<TestHarness popoverProps={{ onClose }} />);
    });

    const insideBtn = document.body.querySelector('#inside-btn')!;
    const triggerBtn = document.body.querySelector('#trigger-btn')!;
    const outsideBtn = document.createElement('button');
    outsideBtn.id = 'outside-btn';
    document.body.appendChild(outsideBtn);

    try {
      // 1. Click inside popover -> does NOT call onClose
      await act(async () => {
        insideBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        insideBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(onClose).not.toHaveBeenCalled();

      // 2. Click on anchor/trigger -> does NOT call onClose
      await act(async () => {
        triggerBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        triggerBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(onClose).not.toHaveBeenCalled();

      // 3. Click outside element -> calls onClose(false) exactly ONCE even if pointerdown + mousedown fire
      await act(async () => {
        outsideBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        outsideBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith(false);
    } finally {
      outsideBtn.remove();
    }
  });

  it('handles Escape capture-phase dismissal and synchronously returns focus to trigger', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root!.render(<TestHarness popoverProps={{ onClose, restoreFocusOnClose: true }} />);
    });

    const triggerBtn = document.body.querySelector<HTMLButtonElement>('#trigger-btn')!;
    triggerBtn.focus();
    expect(document.activeElement).toBe(triggerBtn);

    const insideBtn = document.body.querySelector<HTMLButtonElement>('#inside-btn')!;
    insideBtn.focus();
    expect(document.activeElement).toBe(insideBtn);

    // Press Escape
    await act(async () => {
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      window.dispatchEvent(escapeEvent);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(true);
    // Focus returned synchronously to trigger
    expect(document.activeElement).toBe(triggerBtn);
  });

  it('returns focus to returnFocusRef or falls back to previousFocusRef when anchor is not focusable', async () => {
    const onClose = vi.fn();

    function NonFocusableAnchorHarness() {
      const anchorDivRef = useRef<HTMLDivElement>(null);
      const customReturnRef = useRef<HTMLButtonElement>(null);
      const [showPopover, setShowPopover] = useState(false);

      return (
        <div>
          <button ref={customReturnRef} type="button" id="explicit-return-btn" onClick={() => setShowPopover(true)}>
            Explicit Return Focus
          </button>
          <div
            ref={(el) => {
              anchorDivRef.current = el;
              if (el) {
                el.getBoundingClientRect = () =>
                  ({ top: 100, left: 100, bottom: 130, right: 180, width: 80, height: 30 }) as DOMRect;
              }
            }}
            id="non-focusable-anchor"
          >
            I am a plain div
          </div>
          {showPopover && (
            <AnchoredPopover
              anchorRef={anchorDivRef}
              returnFocusRef={customReturnRef}
              open={true}
              onClose={onClose}
              data-testid="return-ref-popover"
            >
              <button type="button" id="inside-test-btn">
                Inside
              </button>
            </AnchoredPopover>
          )}
        </div>
      );
    }

    await act(async () => {
      root!.render(<NonFocusableAnchorHarness />);
    });

    const btn = document.body.querySelector<HTMLButtonElement>('#explicit-return-btn')!;
    btn.focus();
    expect(document.activeElement).toBe(btn);

    // Open popover by clicking button
    await act(async () => {
      btn.click();
    });

    const insideBtn = document.body.querySelector<HTMLButtonElement>('#inside-test-btn')!;
    insideBtn.focus();
    expect(document.activeElement).toBe(insideBtn);

    // Press Escape
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(onClose).toHaveBeenCalledWith(true);
    // Focus returned to explicit returnFocusRef
    expect(document.activeElement).toBe(btn);
  });

  it('respects e.isComposing and e.defaultPrevented when handling Escape', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root!.render(<TestHarness popoverProps={{ onClose }} />);
    });

    // 1. isComposing = true (IME active)
    await act(async () => {
      const composingEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(composingEvent, 'isComposing', { value: true });
      window.dispatchEvent(composingEvent);
    });
    expect(onClose).not.toHaveBeenCalled();

    // 2. defaultPrevented = true
    await act(async () => {
      const preventedEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      preventedEvent.preventDefault();
      window.dispatchEvent(preventedEvent);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('handles Escape in topmost-only order when multiple popovers are open (nested stack)', async () => {
    const onTopClose = vi.fn();
    const onBottomClose = vi.fn();

    function NestedHarness() {
      const anchor1Ref = useRef<HTMLButtonElement>(null);
      const anchor2Ref = useRef<HTMLButtonElement>(null);

      return (
        <div>
          <button ref={anchor1Ref} type="button" id="anchor-1">
            Anchor 1
          </button>
          <button ref={anchor2Ref} type="button" id="anchor-2">
            Anchor 2
          </button>

          <AnchoredPopover anchorRef={anchor1Ref} open={true} onClose={onBottomClose} data-testid="bottom-popover">
            Bottom
          </AnchoredPopover>
          <AnchoredPopover anchorRef={anchor2Ref} open={true} onClose={onTopClose} data-testid="top-popover">
            Top
          </AnchoredPopover>
        </div>
      );
    }

    await act(async () => {
      root!.render(<NestedHarness />);
    });

    // First Escape closes only the topmost popover
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

    expect(onTopClose).toHaveBeenCalledTimes(1);
    expect(onBottomClose).not.toHaveBeenCalled();
  });

  it('sets data-placement to "top" when placement="top" and unflipped, and "bottom" when flipped', async () => {
    function TopPlacementHarness({ flip }: { flip?: boolean }) {
      const anchorRef = useRef<HTMLButtonElement>(null);
      const popoverRef = useRef<HTMLDivElement>(null);

      return (
        <div>
          <button
            ref={(el) => {
              anchorRef.current = el;
              if (el) {
                // Near top of screen: top: 20 -> will flip below if flip is allowed and popover has height
                el.getBoundingClientRect = () =>
                  ({ top: 20, left: 100, bottom: 50, right: 180, width: 80, height: 30 }) as DOMRect;
              }
            }}
            type="button"
          >
            Anchor
          </button>
          <AnchoredPopover
            ref={(el) => {
              popoverRef.current = el;
              if (el) {
                el.getBoundingClientRect = () =>
                  ({ top: 0, left: 0, bottom: 100, right: 100, width: 100, height: 100 }) as DOMRect;
              }
            }}
            anchorRef={anchorRef}
            placement="top"
            flip={flip}
            open={true}
            onClose={vi.fn()}
            data-testid="placement-popover"
          >
            Content
          </AnchoredPopover>
        </div>
      );
    }

    // When flip is false, stays on top
    await act(async () => {
      root!.render(<TopPlacementHarness flip={false} />);
    });
    let popover = document.body.querySelector('[data-testid="placement-popover"]');
    expect(popover?.getAttribute('data-placement')).toBe('top');

    // When flip is true and near top of screen with 100px popover height, flips to bottom
    await act(async () => {
      root!.render(<TopPlacementHarness flip={true} />);
    });
    popover = document.body.querySelector('[data-testid="placement-popover"]');
    expect(popover?.getAttribute('data-placement')).toBe('bottom');
  });

  describe('scroll dismissal and movement gating', () => {
    it('does not close when scroll event occurs but anchor rect is stationary', async () => {
      const onClose = vi.fn();

      await act(async () => {
        root!.render(<TestHarness popoverProps={{ onClose, closeOnScroll: true }} />);
      });

      // Dispatch scroll while anchor has not moved
      await act(async () => {
        window.dispatchEvent(new Event('scroll'));
      });

      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes when anchor rect moves > 1px and closeOnScroll is true', async () => {
      const onClose = vi.fn();

      await act(async () => {
        root!.render(<TestHarness popoverProps={{ onClose, closeOnScroll: true }} />);
      });

      const triggerBtn = document.body.querySelector<HTMLButtonElement>('#trigger-btn')!;
      // Simulate anchor moving by 10px vertically
      triggerBtn.getBoundingClientRect = () =>
        ({ top: 110, left: 100, bottom: 140, right: 180, width: 80, height: 30 }) as DOMRect;

      await act(async () => {
        window.dispatchEvent(new Event('scroll'));
      });

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledWith(false);
    });

    it('does not close and re-positions when anchor rect moves and closeOnScroll is false', async () => {
      const onClose = vi.fn();

      await act(async () => {
        root!.render(<TestHarness popoverProps={{ onClose, closeOnScroll: false, gap: 4 }} />);
      });

      const triggerBtn = document.body.querySelector<HTMLButtonElement>('#trigger-btn')!;
      const popover = document.body.querySelector<HTMLDivElement>('[data-testid="test-popover"]')!;

      // Initial position based on top: 100, bottom: 130, gap: 4 -> top = 134
      expect(popover.style.top).toBe('134px');

      // Move anchor down by 40px
      triggerBtn.getBoundingClientRect = () =>
        ({ top: 140, left: 100, bottom: 170, right: 180, width: 80, height: 30 }) as DOMRect;

      await act(async () => {
        window.dispatchEvent(new Event('scroll'));
      });

      // Stays open (no onClose)
      expect(onClose).not.toHaveBeenCalled();
      // Repositioned to bottom: 170 + gap: 4 = 174px
      expect(popover.style.top).toBe('174px');
    });

    it('ignores scroll events originating from inside the popover', async () => {
      const onClose = vi.fn();

      await act(async () => {
        root!.render(<TestHarness popoverProps={{ onClose, closeOnScroll: true }} />);
      });

      const popover = document.body.querySelector('[data-testid="test-popover"]')!;
      const insideScroll = new Event('scroll', { bubbles: true });

      await act(async () => {
        popover.dispatchEvent(insideScroll);
      });

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('re-positions immediately when anchorKey changes while open is true', async () => {
    function KeyHarness({ anchorKey }: { anchorKey: string }) {
      const triggerRef = useRef<HTMLButtonElement>(null);

      return (
        <div>
          <button
            ref={(el) => {
              triggerRef.current = el;
              if (el) {
                const top = anchorKey === 'a' ? 100 : 200;
                el.getBoundingClientRect = () =>
                  ({ top, left: 50, bottom: top + 30, right: 150, width: 100, height: 30 }) as DOMRect;
              }
            }}
            type="button"
          >
            Trigger
          </button>
          <AnchoredPopover
            anchorRef={triggerRef}
            anchorKey={anchorKey}
            open={true}
            onClose={vi.fn()}
            gap={4}
            data-testid="key-popover"
          >
            <div>Content</div>
          </AnchoredPopover>
        </div>
      );
    }

    await act(async () => {
      root!.render(<KeyHarness anchorKey="a" />);
    });

    const popover = document.body.querySelector<HTMLDivElement>('[data-testid="key-popover"]')!;
    expect(popover.style.top).toBe('134px'); // 100 + 30 + 4

    // Change anchorKey to 'b'
    await act(async () => {
      root!.render(<KeyHarness anchorKey="b" />);
    });

    expect(popover.style.top).toBe('234px'); // 200 + 30 + 4
  });

  it('FilterBar regression: mousedown and focusin inside portalled date-range picker do not close filter panel', async () => {
    const closeFilter = vi.fn();

    function FilterBarWithDatePickerSimulation() {
      const panelRef = useRef<HTMLDivElement>(null);
      const datePickerAnchorRef = useRef<HTMLButtonElement>(null);

      // Simulates FilterBar's isInsideFilter logic from src/components/FilterBar.tsx
      const isInsideFilter = (node: Node | null) =>
        Boolean(
          node &&
          (panelRef.current?.contains(node) ||
            (node instanceof Element && Boolean(node.closest('[data-popover="date-range"]')))),
        );

      return (
        <div>
          <div
            ref={panelRef}
            id="filter-panel"
            tabIndex={-1}
            onMouseDown={(e) => {
              if (!isInsideFilter(e.target as Node)) closeFilter();
            }}
          >
            <button ref={datePickerAnchorRef} type="button" id="date-range-anchor">
              Date range
            </button>
          </div>

          <AnchoredPopover
            anchorRef={datePickerAnchorRef}
            open={true}
            onClose={vi.fn()}
            data-popover="date-range"
            data-testid="date-range-popover"
          >
            <button type="button" id="day-cell-btn">
              15
            </button>
          </AnchoredPopover>
        </div>
      );
    }

    await act(async () => {
      root!.render(<FilterBarWithDatePickerSimulation />);
    });

    const dayBtn = document.body.querySelector<HTMLButtonElement>('#day-cell-btn')!;
    expect(dayBtn).not.toBeNull();

    // Mousedown on day cell in portalled popover
    await act(async () => {
      dayBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      dayBtn.focus();
    });

    // Filter panel should NOT have closed
    expect(closeFilter).not.toHaveBeenCalled();
  });
});
