import { describe, expect, it } from 'vitest';
import {
  anchorDayOffset,
  anchoredScrollLeft,
  clampDayWidth,
  DEFAULT_DAY_WIDTH,
  dayOffsetToMs,
  deriveTimeScale,
  MAX_DAY_WIDTH,
  MIN_DAY_WIDTH,
  msToDayOffset,
  wheelZoomFactor,
  ZOOM_STEP,
  zoomDayWidth,
} from './timelineZoom';

describe('clampDayWidth', () => {
  it('keeps the zoom inside the supported range', () => {
    expect(clampDayWidth(1)).toBe(MIN_DAY_WIDTH);
    expect(clampDayWidth(1000)).toBe(MAX_DAY_WIDTH);
    expect(clampDayWidth(28)).toBe(28);
  });

  it('falls back to the default for a broken value', () => {
    expect(clampDayWidth(Number.NaN)).toBe(DEFAULT_DAY_WIDTH);
    expect(clampDayWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_DAY_WIDTH);
  });
});

describe('zoomDayWidth', () => {
  it('scales multiplicatively, so each press feels the same at any zoom', () => {
    expect(zoomDayWidth(20, ZOOM_STEP)).toBe(25);
    expect(zoomDayWidth(25, 1 / ZOOM_STEP)).toBe(20);
  });

  it('stops at the ends of the range instead of overshooting', () => {
    expect(zoomDayWidth(MAX_DAY_WIDTH, 2)).toBe(MAX_DAY_WIDTH);
    expect(zoomDayWidth(MIN_DAY_WIDTH, 0.5)).toBe(MIN_DAY_WIDTH);
  });

  it('ignores a nonsense factor', () => {
    expect(zoomDayWidth(28, 0)).toBe(28);
    expect(zoomDayWidth(28, -1)).toBe(28);
    expect(zoomDayWidth(28, Number.NaN)).toBe(28);
  });

  it('can reach both ends of the range by repeated steps', () => {
    let w = DEFAULT_DAY_WIDTH;
    for (let i = 0; i < 50; i++) w = zoomDayWidth(w, ZOOM_STEP);
    expect(w).toBe(MAX_DAY_WIDTH);
    for (let i = 0; i < 50; i++) w = zoomDayWidth(w, 1 / ZOOM_STEP);
    expect(w).toBe(MIN_DAY_WIDTH);
  });
});

describe('deriveTimeScale', () => {
  it('picks the granularity that fits the zoom level', () => {
    expect(deriveTimeScale(MAX_DAY_WIDTH)).toBe('day');
    expect(deriveTimeScale(28)).toBe('day');
    expect(deriveTimeScale(16)).toBe('day');
    expect(deriveTimeScale(15.9)).toBe('week');
    expect(deriveTimeScale(7)).toBe('week');
    expect(deriveTimeScale(6)).toBe('week');
    expect(deriveTimeScale(5.9)).toBe('month');
    expect(deriveTimeScale(MIN_DAY_WIDTH)).toBe('month');
  });

  it('matches the scales the old day/week/month buttons produced', () => {
    // The buttons multiplied a 28px base by 1, 0.25 and 0.125
    expect(deriveTimeScale(28)).toBe('day');
    expect(deriveTimeScale(28 * 0.25)).toBe('week');
    expect(deriveTimeScale(28 * 0.125)).toBe('month');
  });

  it('never leaves a gap between zoom and granularity', () => {
    for (let w = MIN_DAY_WIDTH; w <= MAX_DAY_WIDTH; w += 0.5) {
      expect(['day', 'week', 'month']).toContain(deriveTimeScale(w));
    }
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in scrolling up and out scrolling down', () => {
    expect(wheelZoomFactor(-50)).toBeGreaterThan(1);
    expect(wheelZoomFactor(50)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it('clamps a coarse mouse wheel to one step at most', () => {
    expect(wheelZoomFactor(-1000)).toBe(2);
    expect(wheelZoomFactor(1000)).toBe(0.5);
  });

  it('normalizes line and page deltas so every device zooms comparably', () => {
    // 3 lines ≈ 48px, 1 page ≈ 400px
    expect(wheelZoomFactor(3, 1)).toBeCloseTo(wheelZoomFactor(48, 0), 6);
    expect(wheelZoomFactor(1, 2)).toBeCloseTo(wheelZoomFactor(400, 0), 6);
  });
});

describe('pointer-anchored zoom', () => {
  const fixedColsWidth = 500;

  it('keeps the date under the pointer in place across a zoom', () => {
    const dayWidth = 28;
    const pointerOffsetX = 800;
    const scrollLeft = 2000;

    const offset = anchorDayOffset({ pointerOffsetX, scrollLeft, fixedColsWidth, dayWidth });
    // (2000 + 800 - 500) / 28 = day 82.1 of the chart
    expect(offset).toBeCloseTo(2300 / 28, 6);

    for (const nextDayWidth of [4, 7, 16, 40, 72]) {
      const nextScrollLeft = anchoredScrollLeft({
        anchorDayOffset: offset,
        pointerOffsetX,
        fixedColsWidth,
        dayWidth: nextDayWidth,
      });
      // The same day must still sit under the pointer afterwards
      const after = anchorDayOffset({
        pointerOffsetX,
        scrollLeft: nextScrollLeft,
        fixedColsWidth,
        dayWidth: nextDayWidth,
      });
      expect(nextScrollLeft).toBeGreaterThan(0);
      expect(after).toBeCloseTo(offset, 6);
    }
  });

  it('gives up the anchor rather than scrolling past the start of the chart', () => {
    // Zoomed far out the whole chart is narrower than the pointer's offset, so the
    // anchored position would be negative: pin to the start instead
    const offset = anchorDayOffset({ pointerOffsetX: 800, scrollLeft: 200, fixedColsWidth, dayWidth: 28 });
    expect(anchoredScrollLeft({ anchorDayOffset: offset, pointerOffsetX: 800, fixedColsWidth, dayWidth: 4 })).toBe(0);
  });

  it('anchors to the first day when the pointer is over the fixed columns', () => {
    expect(anchorDayOffset({ pointerOffsetX: 100, scrollLeft: 0, fixedColsWidth, dayWidth: 28 })).toBe(0);
  });

  it('never scrolls to a negative offset', () => {
    expect(anchoredScrollLeft({ anchorDayOffset: 0, pointerOffsetX: 900, fixedColsWidth, dayWidth: 28 })).toBe(0);
  });

  it('clamps to maxScrollLeft when an upper bound is provided', () => {
    const scroll = anchoredScrollLeft({
      anchorDayOffset: 100,
      pointerOffsetX: 100,
      fixedColsWidth: 500,
      dayWidth: 28,
      maxScrollLeft: 1200,
    });
    // Unclamped would be 500 + 2800 - 100 = 3200; clamped is 1200
    expect(scroll).toBe(1200);
  });

  it('keeps target scroll when target is <= maxScrollLeft', () => {
    const scroll = anchoredScrollLeft({
      anchorDayOffset: 10,
      pointerOffsetX: 100,
      fixedColsWidth: 500,
      dayWidth: 28,
      maxScrollLeft: 1200,
    });
    // Target is 500 + 280 - 100 = 680 <= 1200
    expect(scroll).toBe(680);
  });

  it('clamps negative maxScrollLeft to 0', () => {
    const scroll = anchoredScrollLeft({
      anchorDayOffset: 10,
      pointerOffsetX: 100,
      fixedColsWidth: 500,
      dayWidth: 28,
      maxScrollLeft: -50,
    });
    expect(scroll).toBe(0);
  });

  it('ignores non-finite maxScrollLeft values (Infinity and NaN)', () => {
    const base = {
      anchorDayOffset: 10,
      pointerOffsetX: 100,
      fixedColsWidth: 500,
      dayWidth: 28,
    };
    expect(anchoredScrollLeft({ ...base, maxScrollLeft: Number.POSITIVE_INFINITY })).toBe(680);
    expect(anchoredScrollLeft({ ...base, maxScrollLeft: Number.NEGATIVE_INFINITY })).toBe(680);
    expect(anchoredScrollLeft({ ...base, maxScrollLeft: Number.NaN })).toBe(680);
  });

  it('survives the chart start moving, which happens when the granularity changes', () => {
    const chartStartMs = Date.UTC(2026, 10, 15);
    const anchorMs = dayOffsetToMs(chartStartMs, 17.5);
    // The chart start snaps back three days to a week boundary
    const newChartStartMs = Date.UTC(2026, 10, 12);
    expect(msToDayOffset(newChartStartMs, anchorMs)).toBeCloseTo(20.5, 6);
  });
});
