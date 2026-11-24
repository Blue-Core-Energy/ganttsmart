import { describe, expect, it } from 'vitest';
import { computePopoverPosition } from './popoverPosition';

describe('computePopoverPosition', () => {
  const defaultViewport = { width: 1280, height: 800 };
  const defaultPopover = { width: 200, height: 150 };

  it('positions below anchor aligned with left edge by default', () => {
    const anchor = { top: 100, left: 100, bottom: 130, right: 180 };
    const pos = computePopoverPosition(anchor, defaultPopover, defaultViewport, { gap: 4, viewportMargin: 8 });

    expect(pos).toEqual({
      top: 134, // 130 + 4
      left: 100,
      flipped: false,
      actualPlacement: 'bottom',
    });
  });

  it('calculates anchor bottom and right from width/height if omitted', () => {
    const anchor = { top: 100, left: 100, width: 80, height: 30 };
    const pos = computePopoverPosition(anchor, defaultPopover, defaultViewport, { gap: 6 });

    expect(pos).toEqual({
      top: 136, // 100 + 30 + 6
      left: 100,
      flipped: false,
      actualPlacement: 'bottom',
    });
  });

  describe('viewport clamping on narrow screens (375px+)', () => {
    const mobileViewport = { width: 375, height: 667 };

    it('clamps popover within viewport when anchor is near the right edge', () => {
      const anchor = { top: 100, left: 250, bottom: 130, right: 350 };
      const popover = { width: 240, height: 200 };
      const pos = computePopoverPosition(anchor, popover, mobileViewport, { viewportMargin: 8 });

      // Ideal left = 250, but 250 + 240 = 490 > 375 - 8 (367)
      // Clamped maxLeft = 375 - 240 - 8 = 127
      expect(pos.left).toBe(127);
      expect(pos.left + popover.width).toBeLessThanOrEqual(mobileViewport.width - 8);
      expect(pos.left).toBeGreaterThanOrEqual(8);
    });

    it('clamps popover within viewport when anchor is near or past left edge (negative scroll)', () => {
      const anchor = { top: 100, left: -40, bottom: 130, right: 20 };
      const popover = { width: 240, height: 200 };
      const pos = computePopoverPosition(anchor, popover, mobileViewport, { viewportMargin: 8 });

      expect(pos.left).toBe(8); // Clamped to viewportMargin
    });

    it('safely clamps when popover is wider than viewport', () => {
      const anchor = { top: 100, left: 100, bottom: 130, right: 200 };
      const hugePopover = { width: 400, height: 200 }; // wider than 375px
      const pos = computePopoverPosition(anchor, hugePopover, mobileViewport, { viewportMargin: 8 });

      // Clamps to minLeft (8) instead of negative coordinates
      expect(pos.left).toBe(8);
    });
  });

  describe('horizontal alignment and horizontal flip', () => {
    it('supports align: end aligning right edges', () => {
      const anchor = { top: 100, left: 200, bottom: 130, right: 280 };
      const popover = { width: 150, height: 100 };
      const pos = computePopoverPosition(anchor, popover, defaultViewport, { align: 'end' });

      // Ideal left = anchor.right - popover.width = 280 - 150 = 130
      expect(pos.left).toBe(130);
    });

    it('clamps align: end when anchor.right is too close to left edge', () => {
      const anchor = { top: 100, left: 20, bottom: 130, right: 50 };
      const popover = { width: 150, height: 100 };
      const pos = computePopoverPosition(anchor, popover, defaultViewport, { align: 'end', viewportMargin: 8 });

      // Ideal left = 50 - 150 = -100 -> clamped to 8
      expect(pos.left).toBe(8);
    });

    it('flips horizontal alignment from start to end when flipHorizontal is true and start overflows', () => {
      const anchor = { top: 100, left: 1200, bottom: 130, right: 1260 };
      const popover = { width: 200, height: 100 };
      // Viewport width = 1280. anchorLeft (1200) + 200 = 1400 > 1272.
      // If flipped to end: anchorRight (1260) - 200 = 1060 >= 8.
      const pos = computePopoverPosition(anchor, popover, defaultViewport, {
        align: 'start',
        flipHorizontal: true,
        viewportMargin: 8,
      });

      expect(pos.left).toBe(1060);
    });

    it('flips horizontal alignment from end to start when flipHorizontal is true and end overflows', () => {
      const anchor = { top: 100, left: 20, bottom: 130, right: 80 };
      const popover = { width: 200, height: 100 };
      // Ideal end: 80 - 200 = -120 < 8.
      // If flipped to start: anchorLeft (20) + 200 = 220 <= 1272.
      const pos = computePopoverPosition(anchor, popover, defaultViewport, {
        align: 'end',
        flipHorizontal: true,
        viewportMargin: 8,
      });

      expect(pos.left).toBe(20);
    });
  });

  describe('vertical flip and clamping', () => {
    it('flips above when near bottom edge and more space is above than below', () => {
      // Viewport height: 800. Anchor at bottom: 740. Popover height: 200.
      // Space below: 800 - 740 - 8 = 52. Space above: 710 - 8 = 702.
      const anchor = { top: 710, left: 100, bottom: 740, right: 180 };
      const popover = { width: 150, height: 200 };
      const pos = computePopoverPosition(anchor, popover, defaultViewport, { gap: 4, viewportMargin: 8 });

      expect(pos.flipped).toBe(true);
      // top = anchor.top - gap - popover.height = 710 - 4 - 200 = 506
      expect(pos.top).toBe(506);
      expect(pos.bottom).toBe(defaultViewport.height - anchor.top + 4);
    });

    it('clamps top to viewportMargin when flipped popover is taller than space above', () => {
      // Anchor at top: 100, bottom: 130. Viewport height: 200.
      // Space below: 200 - 130 - 8 = 62. Space above: 100 - 8 = 92.
      // Space above (92) > space below (62), so it flips above.
      // Popover height: 150. Ideal top = 100 - 4 - 150 = -54.
      const smallViewport = { width: 500, height: 200 };
      const anchor = { top: 100, left: 100, bottom: 130, right: 180 };
      const popover = { width: 150, height: 150 };
      const pos = computePopoverPosition(anchor, popover, smallViewport, { gap: 4, viewportMargin: 8 });

      expect(pos.flipped).toBe(true);
      expect(pos.top).toBe(8); // Clamped to viewportMargin
    });

    it('does not flip above when space above is less than space below', () => {
      // Anchor near top: top = 40, bottom = 70. Viewport height: 300.
      // Popover height: 280.
      // Space below: 300 - 70 - 8 = 222. Space above: 40 - 8 = 32.
      // Space above < space below, so it stays below even if it overflows.
      const viewport = { width: 500, height: 300 };
      const anchor = { top: 40, left: 100, bottom: 70, right: 180 };
      const popover = { width: 150, height: 280 };
      const pos = computePopoverPosition(anchor, popover, viewport, { gap: 4, viewportMargin: 8 });

      expect(pos.flipped).toBe(false);
      expect(pos.top).toBe(74); // 70 + 4
    });

    it('respects flip: false to prevent flipping', () => {
      const anchor = { top: 750, left: 100, bottom: 780, right: 180 };
      const popover = { width: 150, height: 200 };
      const pos = computePopoverPosition(anchor, popover, defaultViewport, { flip: false, gap: 4 });

      expect(pos.flipped).toBe(false);
      expect(pos.top).toBe(784);
    });

    it('supports minSpaceBelowToAvoidFlip threshold (e.g. 180px for CellMenu)', () => {
      // Popover height is 100, but minSpaceBelowToAvoidFlip is 180.
      // Space below is 150 (< 180). Space above is 400 (> 150).
      const anchor = { top: 408, left: 100, bottom: 438, right: 180 };
      const viewport = { width: 800, height: 600 };
      // Space below = 600 - 438 - 8 = 154 (< 180). Space above = 408 - 8 = 400.
      const popover = { width: 150, height: 100 };
      const pos = computePopoverPosition(anchor, popover, viewport, {
        gap: 4,
        viewportMargin: 8,
        minSpaceBelowToAvoidFlip: 180,
      });

      expect(pos.flipped).toBe(true);
    });

    it('supports placement: top and flips below if needed', () => {
      // Prefers top. Anchor at top: 300, bottom: 330.
      // Space above: 300 - 8 = 292 >= 150 + 4. Fits above!
      const anchor = { top: 300, left: 100, bottom: 330, right: 180 };
      const pos = computePopoverPosition(anchor, defaultPopover, defaultViewport, { placement: 'top', gap: 4 });

      expect(pos.flipped).toBe(false);
      expect(pos.actualPlacement).toBe('top');
      expect(pos.top).toBe(300 - 4 - 150); // 146

      // Near top of screen: flips to bottom
      const nearTopAnchor = { top: 40, left: 100, bottom: 70, right: 180 };
      const posFlipped = computePopoverPosition(nearTopAnchor, defaultPopover, defaultViewport, {
        placement: 'top',
        gap: 4,
      });

      expect(posFlipped.flipped).toBe(true);
      expect(posFlipped.actualPlacement).toBe('bottom');
      expect(posFlipped.top).toBe(74); // 70 + 4
    });

    it('rounds subpixel positions to clean integer coordinates', () => {
      const subpixelAnchor = { top: 100.4, left: 100.6, bottom: 130.3, right: 180.8 };
      const pos = computePopoverPosition(subpixelAnchor, defaultPopover, defaultViewport, { gap: 4.2 });

      expect(Number.isInteger(pos.top)).toBe(true);
      expect(Number.isInteger(pos.left)).toBe(true);
      expect(pos.top).toBe(Math.round(130.3 + 4.2));
      expect(pos.left).toBe(Math.round(100.6));
    });
  });

  describe('zero and negative viewport / dimension edge cases', () => {
    it('handles zero and negative viewport dimensions gracefully', () => {
      const anchor = { top: 100, left: 100, bottom: 130, right: 180 };
      const zeroViewport = { width: 0, height: 0 };
      const pos = computePopoverPosition(anchor, defaultPopover, zeroViewport, { viewportMargin: 8 });

      expect(Number.isFinite(pos.top)).toBe(true);
      expect(Number.isFinite(pos.left)).toBe(true);
      expect(pos.left).toBe(8);
      expect(pos.top).toBeGreaterThanOrEqual(8);
    });

    it('handles negative anchor coordinates gracefully', () => {
      const anchor = { top: -200, left: -300, bottom: -170, right: -220 };
      const pos = computePopoverPosition(anchor, defaultPopover, defaultViewport, { viewportMargin: 8 });

      expect(pos.left).toBe(8);
      expect(pos.top).toBe(8);
    });

    it('handles negative margin and gap gracefully', () => {
      const anchor = { top: 100, left: 100, bottom: 130, right: 180 };
      const pos = computePopoverPosition(anchor, defaultPopover, defaultViewport, {
        viewportMargin: -10,
        gap: -5,
      });

      expect(pos.left).toBe(100);
      expect(pos.top).toBe(130);
    });

    it('handles zero and negative popover dimensions gracefully', () => {
      const anchor = { top: 100, left: 100, bottom: 130, right: 180 };
      const pos = computePopoverPosition(anchor, { width: 0, height: 0 }, defaultViewport);

      expect(pos.left).toBe(100);
      expect(pos.top).toBe(134);
    });
  });
});
