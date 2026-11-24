import { describe, expect, it } from 'vitest';
import { computeTaskIndent, INDENT_PER_DEPTH, INDENT_PER_DEPTH_NARROW, MAX_TASK_INDENT_NARROW } from './ganttLayout';

describe('ganttLayout - computeTaskIndent', () => {
  it('returns 0 for zero or negative depth', () => {
    expect(computeTaskIndent(0)).toBe(0);
    expect(computeTaskIndent(-1)).toBe(0);
    expect(computeTaskIndent(0, true)).toBe(0);
    expect(computeTaskIndent(-5, true)).toBe(0);
  });

  describe('desktop / wide viewports', () => {
    it('scales linearly by INDENT_PER_DEPTH (18px)', () => {
      expect(INDENT_PER_DEPTH).toBe(18);
      expect(computeTaskIndent(1, false)).toBe(18);
      expect(computeTaskIndent(2, false)).toBe(36);
      expect(computeTaskIndent(3, false)).toBe(54);
      expect(computeTaskIndent(5, false)).toBe(90);
      expect(computeTaskIndent(7, false)).toBe(126);
      expect(computeTaskIndent(10, false)).toBe(180);
    });

    it('infers wide viewport when colWidth > 200', () => {
      expect(computeTaskIndent(3, { colWidth: 280 })).toBe(54);
      expect(computeTaskIndent(7, { colWidth: 240 })).toBe(126);
    });
  });

  describe('narrow viewports (< 768px, mobile 200px cell)', () => {
    it('uses INDENT_PER_DEPTH_NARROW (10px) for depths 1 through 5', () => {
      expect(INDENT_PER_DEPTH_NARROW).toBe(10);
      expect(computeTaskIndent(1, true)).toBe(10);
      expect(computeTaskIndent(2, true)).toBe(20);
      expect(computeTaskIndent(3, true)).toBe(30);
      expect(computeTaskIndent(4, true)).toBe(40);
      expect(computeTaskIndent(5, true)).toBe(50);
    });

    it('tapers with 6px steps from depth 6 through 10', () => {
      expect(computeTaskIndent(6, true)).toBe(56);
      expect(computeTaskIndent(7, true)).toBe(62);
      expect(computeTaskIndent(8, true)).toBe(68);
      expect(computeTaskIndent(9, true)).toBe(74);
      expect(computeTaskIndent(10, true)).toBe(80);
    });

    it('caps indent at MAX_TASK_INDENT_NARROW (84px) for depth 11+', () => {
      expect(MAX_TASK_INDENT_NARROW).toBe(84);
      expect(computeTaskIndent(11, true)).toBe(84);
      expect(computeTaskIndent(12, true)).toBe(84);
      expect(computeTaskIndent(20, true)).toBe(84);
    });

    it('is strictly increasing from depth 0 up to depth 11', () => {
      let prev = -1;
      for (let depth = 0; depth <= 11; depth++) {
        const indent = computeTaskIndent(depth, true);
        expect(indent).toBeGreaterThan(prev);
        prev = indent;
      }
    });

    it('infers narrow viewport when colWidth <= 200', () => {
      expect(computeTaskIndent(3, { colWidth: 200 })).toBe(30);
      expect(computeTaskIndent(7, { colWidth: 200 })).toBe(62);
      expect(computeTaskIndent(10, { colWidth: 160 })).toBe(80);
    });

    it('guarantees single-line fit inside a 200px cell with warning, reorder grip, and status dot at any depth', () => {
      // Cell width = 200px. Left and right padding = 18px each (36px total), border-r = 1px.
      // Available client content width = 200 - 36 - 1 = 163px.
      // Reorder grip: 10px icon + (-8px margin) = 2px in flow + 10px gap (gap-2.5) = 12px.
      // Tree gutter: 18px icon + (-2px -ml-0.5) = 16px + 4px gap (gap-1) = 20px.
      // Warning icon (10px) + gap (6px) + status dot (8px in-flow) + gap (6px) = 30px.
      const cellWidth = 200;
      const cellPadding = 36;
      const borderR = 1;
      const availableWidth = cellWidth - cellPadding - borderR; // 163px
      const reorderGrip = 12;
      const gutterAndGap = 20;
      const warningAndDot = 30;
      const fixedChrome = reorderGrip + gutterAndGap + warningAndDot; // 62px

      for (let depth = 0; depth <= 15; depth++) {
        const indent = computeTaskIndent(depth, true);
        const titleSpace = availableWidth - indent - fixedChrome;
        // At maximum indent cap (84px) with warning and reorder grip, title gets ~17-18px to truncate cleanly without clipping
        expect(titleSpace).toBeGreaterThanOrEqual(17);

        // During inline rename, warning and status dot step aside (+30px), giving ~47px room even at max indent
        const renameSpace = titleSpace + warningAndDot;
        expect(renameSpace).toBeGreaterThanOrEqual(47);
      }
    });
  });
});
