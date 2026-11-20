import type { TimeScale } from '@/types';

/** Pixels per day at each end of the zoom range: a packed year through a roomy week */
export const MIN_DAY_WIDTH = 2;
export const MAX_DAY_WIDTH = 72;
export const DEFAULT_DAY_WIDTH = 28;

/** One keyboard zoom press scales by this much */
export const ZOOM_STEP = 1.25;

/**
 * Zoom levels at which the header granularity changes. Day cells need room for a
 * date and a weekday; a week cell spans seven days and shows "Nov 15"; below that
 * only month names fit.
 */
export const DAY_SCALE_MIN_WIDTH = 16;
export const WEEK_SCALE_MIN_WIDTH = 6;

const MS_PER_DAY = 86_400_000;

export function clampDayWidth(dayWidth: number): number {
  if (!Number.isFinite(dayWidth)) return DEFAULT_DAY_WIDTH;
  return Math.min(Math.max(dayWidth, MIN_DAY_WIDTH), MAX_DAY_WIDTH);
}

/** Apply a multiplicative zoom factor, keeping the result inside the range */
export function zoomDayWidth(current: number, factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return clampDayWidth(current);
  return clampDayWidth(current * factor);
}

/** The header granularity that suits a zoom level, so there is nothing to choose by hand */
export function deriveTimeScale(dayWidth: number): TimeScale {
  if (dayWidth >= DAY_SCALE_MIN_WIDTH) return 'day';
  if (dayWidth >= WEEK_SCALE_MIN_WIDTH) return 'week';
  return 'month';
}

/**
 * Zoom factor for one wheel or trackpad-pinch event. Browsers report wheel deltas
 * in pixels, lines or pages, so normalize first, then clamp: a coarse mouse wheel
 * reports ±100px or more per notch and should not jump several zoom levels.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const lineHeight = 16;
  const pageHeight = 400;
  const scale = deltaMode === 1 ? lineHeight : deltaMode === 2 ? pageHeight : 1;
  const pixels = deltaY * scale;
  // Wheel down (positive delta) zooms out
  return Math.min(Math.max(Math.exp(-pixels * 0.002), 0.5), 2);
}

/** Fractional days from the chart start to the date under a pointer */
export function anchorDayOffset({
  pointerOffsetX,
  scrollLeft,
  fixedColsWidth,
  dayWidth,
}: {
  /** Pointer position relative to the scroll container's left edge */
  pointerOffsetX: number;
  scrollLeft: number;
  fixedColsWidth: number;
  dayWidth: number;
}): number {
  const timelineX = Math.max(0, scrollLeft + pointerOffsetX - fixedColsWidth);
  return timelineX / dayWidth;
}

/** Convert a day offset to a timestamp, so an anchor survives the chart start moving */
export function dayOffsetToMs(chartStartMs: number, offsetDays: number): number {
  return chartStartMs + offsetDays * MS_PER_DAY;
}

export function msToDayOffset(chartStartMs: number, ms: number): number {
  return (ms - chartStartMs) / MS_PER_DAY;
}

/** Scroll position that puts a given day offset back under the pointer after a zoom */
export function anchoredScrollLeft({
  anchorDayOffset: offsetDays,
  pointerOffsetX,
  fixedColsWidth,
  dayWidth,
}: {
  anchorDayOffset: number;
  pointerOffsetX: number;
  fixedColsWidth: number;
  dayWidth: number;
}): number {
  return Math.max(0, fixedColsWidth + offsetDays * dayWidth - pointerOffsetX);
}
