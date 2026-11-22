import { describe, expect, it } from 'vitest';
import {
  ARROW_DIRECT_MIN_GAP,
  ARROW_HOP_RADIUS,
  ARROW_LANE_OFFSET,
  ARROW_STAGGER_STEP,
  ARROW_STUB,
  buildArrowPath,
  findHops,
  routeDependencyArrows,
  type DependencyArrowEdge,
  type ArrowEndpoints,
} from './dependencyArrows';

/** Mirrors the Tailwind sizes in GanttRow.tsx: `h-[28px]` bars in `h-[56px]` rows */
const BAR_HEIGHT = 28;
const ROW_HEIGHT = 56;

/** Longest arrowhead, in px — `markerWidth` 8 at userSpaceOnUse in DependencyArrows.tsx */
const ARROW_HEAD = 8;

/** Every x and y coordinate referenced by a path, in order */
function points(path: string): { x: number; y: number }[] {
  const result: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  for (const cmd of path.trim().split(/\s(?=[MHVLQA])/)) {
    const [op, ...args] = cmd.split(/\s+/);
    if (op === 'M' || op === 'L') {
      [x, y] = args.map(Number);
      result.push({ x, y });
    } else if (op === 'H') {
      x = Number(args[0]);
      result.push({ x, y });
    } else if (op === 'V') {
      y = Number(args[0]);
      result.push({ x, y });
    } else if (op === 'Q') {
      const nums = args.join(' ').replace(/,/g, ' ').trim().split(/\s+/).map(Number);
      // nums: [cx, cy, endX, endY]
      result.push({ x: nums[0], y: nums[1] });
      x = nums[2];
      y = nums[3];
      result.push({ x, y });
    } else if (op === 'A') {
      // args: rx ry rotation large-arc sweep endX endY
      x = Number(args[5]);
      y = Number(args[6]);
      result.push({ x, y });
    }
  }
  return result;
}

describe('buildArrowPath', () => {
  const forward: ArrowEndpoints = { fromX: 100, fromY: 50, toX: 300, toY: 94 };

  it('draws a straight line between bars on the same row', () => {
    const path = buildArrowPath({ fromX: 100, fromY: 50, toX: 300, toY: 50 });
    expect(path).toBe('M 100 50 H 300');
  });

  it('turns close to the source bar with rounded elbows for forward dependencies', () => {
    const path = buildArrowPath(forward);
    // Turns near the source at fromX + ARROW_STUB = 112 instead of halfway (200)
    // Corner 1: (112 - 6, 50) -> Q 112 50, 112 56
    // Corner 2: (112, 94 - 6) -> Q 112 94, 118 94
    expect(path).toBe('M 100 50 H 106 Q 112 50, 112 56 V 88 Q 112 94, 118 94 H 300');

    // With sharp corners (cornerRadius: 0), matches exact right angles near source
    const sharp = buildArrowPath(forward, { cornerRadius: 0 });
    expect(sharp).toBe('M 100 50 H 112 V 94 H 300');
  });

  it('dynamically clamps corner radius on short segments so corners never invert or overshoot', () => {
    // Vertical distance is only 8px (< 2 * ARROW_CORNER_RADIUS = 12px)
    // Each corner radius is clamped to 8 / 2 = 4px
    const tightVertical = buildArrowPath({ fromX: 100, fromY: 50, toX: 300, toY: 58 });
    expect(tightVertical).toBe('M 100 50 H 108 Q 112 50, 112 54 Q 112 58, 116 58 H 300');

    // Horizontal distance before turn is only 6px (< 12px)
    const tightHorizontal = buildArrowPath({ fromX: 100, fromY: 50, toX: 118, toY: 94 });
    // When dx = 18 (< 24), turn happens at toX - ARROW_STUB = 118 - 12 = 106
    // First segment length = 106 - 100 = 6px => radius at first corner clamped to 6 / 2 = 3px
    expect(tightHorizontal).toContain('M 100 50 H 103 Q 106 50, 106 53');
  });

  it('routes around through the lane beside the source row when the target starts first', () => {
    const path = buildArrowPath({ fromX: 300, fromY: 50, toX: 100, toY: 94 });
    // Exits right to 312, drops to lane 70, runs back to 88, drops to toY 94, enters toX 100
    expect(path).toContain('M 300 50');
    expect(path).toContain('H 100');
    // All 4 corners have rounded elbows (Q commands)
    const qMatches = path.match(/Q/g);
    expect(qMatches?.length).toBe(4);

    // With cornerRadius: 0, matches exact right angles
    const sharp = buildArrowPath({ fromX: 300, fromY: 50, toX: 100, toY: 94 }, { cornerRadius: 0 });
    expect(sharp).toBe('M 300 50 H 312 V 70 H 88 V 94 H 100');
  });

  it('puts the lane on the side the target is on, so it never runs along another row', () => {
    const below = buildArrowPath({ fromX: 300, fromY: 150, toX: 100, toY: 262 }, { cornerRadius: 0 });
    const above = buildArrowPath({ fromX: 300, fromY: 150, toX: 100, toY: 38 }, { cornerRadius: 0 });
    expect(points(below).some((p) => p.y === 150 + ARROW_LANE_OFFSET)).toBe(true);
    expect(points(above).some((p) => p.y === 150 - ARROW_LANE_OFFSET)).toBe(true);
    // The midpoint of a two-row gap lands on the row between them — avoid it
    expect(points(below).some((p) => p.y === 206)).toBe(false);
    expect(points(above).some((p) => p.y === 94)).toBe(false);
  });

  it('offsets the lane below the row when a dependency doubles back within one row', () => {
    const fromY = 50;
    const path = buildArrowPath({ fromX: 300, fromY, toX: 100, toY: fromY }, { cornerRadius: 0 });
    expect(points(path).some((p) => p.y === fromY + ARROW_LANE_OFFSET)).toBe(true);
  });

  it('keeps a forward dependency moving forwards as the gap narrows', () => {
    expect(
      buildArrowPath({ fromX: 100, fromY: 50, toX: 100 + ARROW_DIRECT_MIN_GAP, toY: 94 }, { cornerRadius: 0 }),
    ).toBe('M 100 50 H 112 V 94 H 124');
    expect(buildArrowPath({ fromX: 100, fromY: 50, toX: 123, toY: 94 }, { cornerRadius: 0 })).toBe(
      'M 100 50 H 111 V 94 H 123',
    );
    expect(buildArrowPath({ fromX: 100, fromY: 50, toX: 100 + ARROW_STUB, toY: 94 }, { cornerRadius: 0 })).toBe(
      'M 100 50 V 94 H 112',
    );

    for (let gap = ARROW_STUB; gap <= 40; gap++) {
      const xs = points(buildArrowPath({ fromX: 100, fromY: 50, toX: 100 + gap, toY: 94 }, { cornerRadius: 0 })).map(
        (p) => p.x,
      );
      // Never travels left of the source, and always approaches over a full stub
      expect(Math.min(...xs)).toBe(100);
      expect(100 + gap - xs[xs.length - 2]).toBeGreaterThanOrEqual(ARROW_STUB);
    }
  });

  it('routes around only when there is no room to enter the target directly', () => {
    const tight = buildArrowPath({ fromX: 100, fromY: 50, toX: 100 + ARROW_STUB - 1, toY: 94 }, { cornerRadius: 0 });
    const direct = buildArrowPath({ fromX: 100, fromY: 50, toX: 100 + ARROW_STUB, toY: 94 }, { cornerRadius: 0 });
    expect(points(tight)).toHaveLength(6);
    expect(points(direct)).toHaveLength(3);
  });

  it('leaves room for the arrowhead on the final approach of every route', () => {
    const cases: ArrowEndpoints[] = [
      { fromX: 100, fromY: 50, toX: 400, toY: 94 },
      { fromX: 100, fromY: 50, toX: 112, toY: 94 },
      { fromX: 300, fromY: 50, toX: 100, toY: 94 },
      { fromX: 100, fromY: 50, toX: 105, toY: 50 },
    ];
    for (const endpoints of cases) {
      const pts = points(buildArrowPath(endpoints, { cornerRadius: 0 }));
      const approach = Math.abs(pts[pts.length - 1].x - pts[pts.length - 2].x);
      expect(approach).toBeGreaterThanOrEqual(ARROW_HEAD);
    }
  });

  it('runs its lane clear of the source bar but inside the row gap', () => {
    expect(ARROW_LANE_OFFSET).toBeGreaterThan(BAR_HEIGHT / 2);
    expect(ARROW_LANE_OFFSET).toBeLessThan(ROW_HEIGHT - BAR_HEIGHT / 2);
  });

  it('starts on the source and ends on the target with horizontal final approach', () => {
    for (const endpoints of [forward, { fromX: 300, fromY: 50, toX: 100, toY: 94 }]) {
      const pts = points(buildArrowPath(endpoints));
      expect(pts[0]).toEqual({ x: endpoints.fromX, y: endpoints.fromY });
      expect(pts[pts.length - 1]).toEqual({ x: endpoints.toX, y: endpoints.toY });

      // Path ends with H ${toX} so the last token in d is always toX
      const path = buildArrowPath(endpoints);
      expect(path.endsWith(`H ${endpoints.toX}`)).toBe(true);
    }
  });
});

/** Vertical runs (same x, different y) of a path routed with sharp corners */
function verticals(path: string): { x: number; y1: number; y2: number }[] {
  const pts = points(path);
  const result: { x: number; y1: number; y2: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x === pts[i - 1].x && pts[i].y !== pts[i - 1].y) {
      result.push({ x: pts[i].x, y1: Math.min(pts[i].y, pts[i - 1].y), y2: Math.max(pts[i].y, pts[i - 1].y) });
    }
  }
  return result;
}

function horizontals(path: string): { y: number; x1: number; x2: number }[] {
  const pts = points(path);
  const result: { y: number; x1: number; x2: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].y === pts[i - 1].y && pts[i].x !== pts[i - 1].x) {
      result.push({ y: pts[i].y, x1: Math.min(pts[i].x, pts[i - 1].x), x2: Math.max(pts[i].x, pts[i - 1].x) });
    }
  }
  return result;
}

const route = (arrows: DependencyArrowEdge[]) => routeDependencyArrows(arrows, { cornerRadius: 0 });

/**
 * Asserts the layout invariant: two vertical runs may only sit on top of each other when their
 * arrows share a source or a target.
 */
function expectNoUnrelatedVerticalOverlap(routed: ReturnType<typeof route>) {
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      const a = routed[i];
      const b = routed[j];
      if (a.sourceId === b.sourceId || a.targetId === b.targetId) continue;
      for (const va of verticals(a.path)) {
        for (const vb of verticals(b.path)) {
          const overlap = Math.min(va.y2, vb.y2) - Math.max(va.y1, vb.y1);
          if (overlap > 2) {
            expect(
              Math.abs(va.x - vb.x),
              `${a.sourceId}->${a.targetId} (x=${va.x}) vs ${b.sourceId}->${b.targetId} (x=${vb.x})`,
            ).toBeGreaterThanOrEqual(ARROW_STAGGER_STEP - 1);
          }
        }
      }
    }
  }
}

describe('routeDependencyArrows', () => {
  it('combines arrows with the same source to exit along the exact same trunk and turn', () => {
    const arrows = [
      { sourceId: 'task-1', targetId: 'task-2', fromX: 100, fromY: 50, toX: 300, toY: 94 },
      { sourceId: 'task-1', targetId: 'task-3', fromX: 100, fromY: 50, toX: 400, toY: 150 },
    ];
    const routed = routeDependencyArrows(arrows);
    expect(routed).toHaveLength(2);
    expect(routed[0].midXOffset).toBe(0);
    expect(routed[1].midXOffset).toBe(0);

    // Both leave (100, 50) and turn at x = 112 with exact same initial path
    expect(routed[0].path.startsWith('M 100 50 H 106 Q 112 50, 112 56')).toBe(true);
    expect(routed[1].path.startsWith('M 100 50 H 106 Q 112 50, 112 56')).toBe(true);
  });

  it('converges arrows with the same destination onto the exact same horizontal final approach', () => {
    const arrows = [
      { sourceId: 'task-1', targetId: 'task-3', fromX: 100, fromY: 50, toX: 400, toY: 150 },
      { sourceId: 'task-2', targetId: 'task-3', fromX: 200, fromY: 100, toX: 400, toY: 150 },
    ];
    const routed = routeDependencyArrows(arrows);
    expect(routed).toHaveLength(2);

    // Both enter (400, 150) horizontally along y = 150
    expect(routed[0].path.endsWith('H 400')).toBe(true);
    expect(routed[1].path.endsWith('H 400')).toBe(true);
  });

  it('staggers vertical tracks of unrelated arrows that share the same midX column and overlap vertically', () => {
    // Both sources end at fromX = 100, so both default to midX = 112
    // Vertical span for arrow 1 is 50 -> 150
    // Vertical span for arrow 2 is 80 -> 200 (overlaps with arrow 1)
    // Different sourceId AND different targetId => unrelated => stagger!
    const arrows = [
      { sourceId: 'task-1', targetId: 'task-2', fromX: 100, fromY: 50, toX: 300, toY: 150 },
      { sourceId: 'task-3', targetId: 'task-4', fromX: 100, fromY: 80, toX: 300, toY: 200 },
    ];
    const routed = routeDependencyArrows(arrows);
    expect(routed).toHaveLength(2);
    expect(routed[0].midXOffset).not.toBe(routed[1].midXOffset);
    expect(Math.abs(routed[0].midXOffset - routed[1].midXOffset)).toBeGreaterThanOrEqual(ARROW_STAGGER_STEP);
  });

  it('does not stagger arrows when vertical spans do not overlap', () => {
    // Arrow 1 spans y: 50 -> 100
    // Arrow 2 spans y: 150 -> 200 (no vertical overlap)
    const arrows = [
      { sourceId: 'task-1', targetId: 'task-2', fromX: 100, fromY: 50, toX: 300, toY: 100 },
      { sourceId: 'task-3', targetId: 'task-4', fromX: 100, fromY: 150, toX: 300, toY: 200 },
    ];
    const routed = routeDependencyArrows(arrows);
    expect(routed[0].midXOffset).toBe(0);
    expect(routed[1].midXOffset).toBe(0);
  });

  it('staggers A->T1 and B->T3 even though A and B also share the target T2', () => {
    const routed = route([
      { sourceId: 'A', targetId: 'T1', fromX: 100, fromY: 50, toX: 300, toY: 162 },
      { sourceId: 'A', targetId: 'T2', fromX: 100, fromY: 50, toX: 400, toY: 218 },
      { sourceId: 'B', targetId: 'T2', fromX: 100, fromY: 106, toX: 400, toY: 218 },
      { sourceId: 'B', targetId: 'T3', fromX: 100, fromY: 106, toX: 300, toY: 274 },
    ]);
    const [aT1, aT2, bT2, bT3] = routed.map((r) => verticals(r.path)[0]);

    // One trunk per source
    expect(aT1.x).toBe(aT2.x);
    expect(bT2.x).toBe(bT3.x);
    // A->T1 (50..162) and B->T3 (106..274) are unrelated and overlap, so they cannot share a column
    expect(Math.abs(aT1.x - bT3.x)).toBeGreaterThanOrEqual(ARROW_STAGGER_STEP);
    expectNoUnrelatedVerticalOverlap(routed);
  });

  it('checks candidates against the final x of every placed column, not their unshifted x', () => {
    // A and B both want x = 112; C wants x = 118. B gets pushed to 118 and C must then move again.
    const routed = route([
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 218 },
      { sourceId: 'B', targetId: 'TB', fromX: 100, fromY: 78, toX: 300, toY: 246 },
      { sourceId: 'C', targetId: 'TC', fromX: 106, fromY: 106, toX: 300, toY: 274 },
    ]);
    const xs = routed.map((r) => verticals(r.path)[0].x);
    expect(new Set(xs).size).toBe(3);
    expectNoUnrelatedVerticalOverlap(routed);
  });

  it('keeps one shared trunk for a source with both wide and tight gaps', () => {
    const routed = route([
      { sourceId: 'A', targetId: 'wide', fromX: 100, fromY: 50, toX: 300, toY: 162 },
      // 18px gap: direct turn would be at 106, not 112
      { sourceId: 'A', targetId: 'tight', fromX: 100, fromY: 50, toX: 118, toY: 218 },
    ]);
    const [wide, tight] = routed.map((r) => verticals(r.path)[0]);
    expect(wide.x).toBe(tight.x);
    expect(wide.x).toBe(106);
    // Each still enters its target with a full arrowhead's worth of approach
    expect(routed[0].path.endsWith('H 300')).toBe(true);
    expect(300 - wide.x).toBeGreaterThanOrEqual(ARROW_STUB);
    expect(118 - tight.x).toBeGreaterThanOrEqual(ARROW_STUB);
  });

  it('draws the exact assigned column instead of recomputing it', () => {
    const [routed] = routeDependencyArrows(
      [{ sourceId: 'A', targetId: 'B', fromX: 100, fromY: 50, toX: 300, toY: 162 }],
      {
        cornerRadius: 0,
      },
    );
    expect(routed.path).toBe('M 100 50 H 112 V 162 H 300');
    expect(buildArrowPath({ fromX: 100, fromY: 50, toX: 300, toY: 162 }, { cornerRadius: 0, turnX: 130 })).toBe(
      'M 100 50 H 130 V 162 H 300',
    );
  });

  it('staggers the long entry runs (toX - stub) of backwards arrows into different targets', () => {
    // Two targets in rows 3 and 4 start at the same x; sources are to their right in rows 1 and 2
    const routed = route([
      { sourceId: 'S1', targetId: 'T1', fromX: 400, fromY: 50, toX: 100, toY: 162 },
      { sourceId: 'S2', targetId: 'T2', fromX: 420, fromY: 106, toX: 100, toY: 218 },
    ]);
    const entries = routed.map((r) => verticals(r.path).find((v) => v.x < 100)!);
    expect(entries.some((e) => e.x === 100 - ARROW_STUB)).toBe(true);
    expect(entries[0].x).not.toBe(entries[1].x);
    // Shifts left, lengthening the approach rather than squeezing the arrowhead
    expect(Math.max(...entries.map((e) => e.x))).toBeLessThanOrEqual(100 - ARROW_STUB);
    expectNoUnrelatedVerticalOverlap(routed);
  });

  it('lets backwards arrows into one target share the entry column and exits from one source share the exit', () => {
    const routed = route([
      { sourceId: 'S1', targetId: 'T', fromX: 400, fromY: 50, toX: 100, toY: 218 },
      { sourceId: 'S2', targetId: 'T', fromX: 420, fromY: 106, toX: 100, toY: 218 },
    ]);
    const entries = routed.map((r) => verticals(r.path).find((v) => v.x < 100)!);
    expect(entries[0].x).toBe(entries[1].x);

    const sameSource = route([
      { sourceId: 'S', targetId: 'T1', fromX: 400, fromY: 50, toX: 100, toY: 162 },
      { sourceId: 'S', targetId: 'T2', fromX: 400, fromY: 50, toX: 80, toY: 218 },
    ]);
    const exits = sameSource.map((r) => verticals(r.path)[0]);
    expect(exits[0].x).toBe(412);
    expect(exits[1].x).toBe(412);
    expect(horizontals(sameSource[0].path).some((h) => h.y === 70)).toBe(true);
    expect(horizontals(sameSource[1].path).some((h) => h.y === 70)).toBe(true);
  });

  it('staggers forward columns against backwards exit and entry columns in the same system', () => {
    const routed = route([
      // Forward column at 112 spanning rows 1-3
      { sourceId: 'F', targetId: 'TF', fromX: 100, fromY: 50, toX: 300, toY: 162 },
      // Backwards exit also wants 112 and drops from row 2 to its lane below (106..126)
      { sourceId: 'B', targetId: 'TB', fromX: 100, fromY: 106, toX: 60, toY: 218 },
      // Backwards entry at 288 collides with nothing, forward entry approach is horizontal
      { sourceId: 'C', targetId: 'TC', fromX: 500, fromY: 50, toX: 300, toY: 218 },
    ]);
    const forwardX = verticals(routed[0].path)[0].x;
    const exitX = verticals(routed[1].path)[0].x;
    expect(forwardX).not.toBe(exitX);
    expectNoUnrelatedVerticalOverlap(routed);
  });

  it('staggers overlapping backwards lanes away from the source bar, never toward it', () => {
    // Below the bar: lanes at fromY + 20, then +26 — never fromY + 14
    const below = route([
      { sourceId: 'S1', targetId: 'T1', fromX: 400, fromY: 50, toX: 100, toY: 162 },
      { sourceId: 'S2', targetId: 'T2', fromX: 250, fromY: 50, toX: 50, toY: 218 },
    ]);
    const belowLanes = below.map((r) =>
      Math.max(
        ...horizontals(r.path)
          .map((h) => h.y)
          .filter((y) => y > 50 && y < 100),
      ),
    );
    expect(belowLanes).toContain(50 + ARROW_LANE_OFFSET);
    expect(belowLanes).toContain(50 + ARROW_LANE_OFFSET + ARROW_STAGGER_STEP);
    expect(Math.min(...belowLanes)).toBeGreaterThanOrEqual(50 + ARROW_LANE_OFFSET);

    // Above the bar: lanes at fromY - 20, then -26
    const above = route([
      { sourceId: 'S1', targetId: 'T1', fromX: 400, fromY: 218, toX: 100, toY: 106 },
      { sourceId: 'S2', targetId: 'T2', fromX: 250, fromY: 218, toX: 50, toY: 50 },
    ]);
    const aboveLanes = above.map((r) =>
      Math.min(
        ...horizontals(r.path)
          .map((h) => h.y)
          .filter((y) => y < 218 && y > 170),
      ),
    );
    expect(aboveLanes).toContain(218 - ARROW_LANE_OFFSET);
    expect(aboveLanes).toContain(218 - ARROW_LANE_OFFSET - ARROW_STAGGER_STEP);
    expect(Math.max(...aboveLanes)).toBeLessThanOrEqual(218 - ARROW_LANE_OFFSET);
  });

  it('keeps clamped columns from landing on an occupied column', () => {
    // 24px gap: the column can only move within 104..116. +6 clamps to 116, which is too close
    // to A at 112, so B has to go the other way instead of being pushed onto A's track.
    const routed = route([
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 124, toY: 162 },
      { sourceId: 'B', targetId: 'TB', fromX: 100, fromY: 78, toX: 124, toY: 218 },
    ]);
    const xs = routed.map((r) => verticals(r.path)[0].x);
    expect(xs[0]).toBe(112);
    expect(xs[1]).toBeLessThanOrEqual(106);
    for (const r of routed) {
      const pts = points(r.path);
      expect(124 - pts[pts.length - 2].x).toBeGreaterThanOrEqual(ARROW_HEAD);
    }
    expectNoUnrelatedVerticalOverlap(routed);
  });
});

describe('crossing hops', () => {
  const R = ARROW_HOP_RADIUS;
  /** Straight arrow along one row: a pure horizontal run to cross */
  const across = (id: string, y: number, fromX = 50, toX = 400): DependencyArrowEdge => ({
    sourceId: `${id}-s`,
    targetId: `${id}-t`,
    fromX,
    fromY: y,
    toX,
    toY: y,
  });
  const arcs = (path: string) => path.match(/A [^A-Z]+/g) ?? [];

  /** Every y the path visits must move monotonically along the direction of each vertical run */
  function expectNoInvertedVerticals(path: string) {
    const pts = points(path);
    for (let i = 2; i < pts.length; i++) {
      const [p0, p1, p2] = [pts[i - 2], pts[i - 1], pts[i]];
      if (p0.x === p1.x && p1.x === p2.x) {
        expect(Math.sign(p1.y - p0.y) * Math.sign(p2.y - p1.y)).toBeGreaterThanOrEqual(0);
      }
    }
  }

  it('hops a downward vertical run to the right over a horizontal run it crosses', () => {
    const [down, line] = routeDependencyArrows([
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 162 },
      across('B', 106),
    ]);
    // Straight run 56 -> 156, hop centred on y = 106
    expect(down.path).toBe(
      `M 100 50 H 106 Q 112 50, 112 56 V ${106 - R} A ${R} ${R} 0 0 1 112 ${106 + R} V 156 Q 112 162, 118 162 H 300`,
    );
    // The line being crossed is untouched
    expect(line.path).toBe('M 50 106 H 400');
  });

  it('hops an upward vertical run with the opposite sweep so it still bulges to the right', () => {
    const [up] = routeDependencyArrows([
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 162, toX: 300, toY: 50 },
      across('B', 106),
    ]);
    expect(up.path).toBe(
      `M 100 162 H 106 Q 112 162, 112 156 V ${106 + R} A ${R} ${R} 0 0 0 112 ${106 - R} V 56 Q 112 50, 118 50 H 300`,
    );
  });

  it('hops over the lane and entry runs of backwards arrows too', () => {
    const [back, cross] = routeDependencyArrows([
      { sourceId: 'S', targetId: 'T', fromX: 400, fromY: 50, toX: 100, toY: 218 },
      across('B', 150, 60, 500),
    ]);
    // Exit column x = 412 passes through the lane at 70 only at its end; entry column (88) crosses y = 150
    expect(arcs(back.path)).toHaveLength(1);
    expect(back.path).toContain(`V ${150 - R} A ${R} ${R} 0 0 1 88 ${150 + R}`);
    expect(arcs(cross.path)).toHaveLength(0);
  });

  it('emits a single hop when several arrows share a horizontal run at the same y', () => {
    const [down] = routeDependencyArrows([
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 162 },
      across('B', 106),
      across('C', 106, 60, 380),
    ]);
    expect(arcs(down.path)).toHaveLength(1);

    const hops = findHops([
      [
        { x: 112, y: 50 },
        { x: 112, y: 162 },
      ],
      [
        { x: 50, y: 106 },
        { x: 400, y: 106 },
      ],
      [
        { x: 60, y: 106 },
        { x: 380, y: 106 },
      ],
    ]);
    expect(hops[0]).toEqual([{ x: 112, y: 106 }]);
    expect(hops[1]).toEqual([]);
    expect(hops[2]).toEqual([]);
  });

  it('orders several hops along the direction of travel', () => {
    const [down, , , up] = routeDependencyArrows([
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 218 },
      across('B', 90),
      across('C', 150),
      { sourceId: 'D', targetId: 'TD', fromX: 500, fromY: 218, toX: 700, toY: 50 },
    ]);
    expect(arcs(down.path)).toHaveLength(2);
    expect(down.path.indexOf(`V ${90 - R}`)).toBeLessThan(down.path.indexOf(`V ${150 - R}`));
    expect(arcs(up.path)).toHaveLength(0);

    const [upward] = routeDependencyArrows([
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 218, toX: 300, toY: 50 },
      across('B', 90),
      across('C', 150),
    ]);
    expect(upward.path.indexOf(`V ${150 + R}`)).toBeLessThan(upward.path.indexOf(`V ${90 + R}`));
    expectNoInvertedVerticals(upward.path);
  });

  it('merges crossings closer than a hop is wide into one taller arc', () => {
    const [down] = routeDependencyArrows([
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 218 },
      across('B', 100),
      across('C', 106),
    ]);
    // 6px apart is less than 2 * R + 2, so one half-ellipse covers y = 100 .. 106
    expect(arcs(down.path)).toEqual([`A ${R} ${3 + R} 0 0 1 112 ${106 + R} `]);
    expect(down.path).toContain(`V ${100 - R} A`);
    expectNoInvertedVerticals(down.path);

    // Exactly far enough apart keeps two separate hops
    const [apart] = routeDependencyArrows([
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 218 },
      across('B', 100),
      across('C', 100 + 2 * R + 2),
    ]);
    expect(arcs(apart.path)).toHaveLength(2);
    expectNoInvertedVerticals(apart.path);
  });

  it('does not hop where a branch leaves a shared trunk', () => {
    const routed = routeDependencyArrows([
      { sourceId: 'A', targetId: 'T1', fromX: 100, fromY: 50, toX: 300, toY: 106 },
      { sourceId: 'A', targetId: 'T2', fromX: 100, fromY: 50, toX: 300, toY: 162 },
      { sourceId: 'A', targetId: 'T3', fromX: 100, fromY: 50, toX: 300, toY: 218 },
    ]);
    // T1 and T2 branch off the trunk that T3 continues down, starting exactly on its column
    for (const r of routed) expect(r.path).not.toContain('A ');
  });

  it('does not hop where arrows merge into one target column or end on a vertical run', () => {
    const merged = routeDependencyArrows([
      { sourceId: 'S1', targetId: 'T', fromX: 400, fromY: 50, toX: 100, toY: 218 },
      { sourceId: 'S2', targetId: 'T', fromX: 420, fromY: 106, toX: 100, toY: 218 },
    ]);
    for (const r of merged) expect(r.path).not.toContain('A ');

    // A horizontal run that only reaches the vertical run (either end) is a junction, not a crossing
    const column = [
      { x: 112, y: 50 },
      { x: 112, y: 162 },
    ];
    const endsAt = (x1: number, x2: number) => [
      { x: x1, y: 106 },
      { x: x2, y: 106 },
    ];
    expect(findHops([column, endsAt(50, 112)])[0]).toEqual([]);
    expect(findHops([column, endsAt(112, 300)])[0]).toEqual([]);
    expect(findHops([column, endsAt(50, 113)])[0]).toEqual([]);
    expect(findHops([column, endsAt(50, 114)])[0]).toEqual([{ x: 112, y: 106 }]);
  });

  it('does not hop at the ends of a vertical run or over a run at the same level as its corners', () => {
    const column = [
      { x: 112, y: 50 },
      { x: 112, y: 162 },
    ];
    // Strictly inside in y only: runs at the endpoints themselves are not crossings
    const level = (y: number) => [
      { x: 50, y },
      { x: 300, y },
    ];
    expect(findHops([column, level(50)])[0]).toEqual([]);
    expect(findHops([column, level(162)])[0]).toEqual([]);
    expect(findHops([column, level(49)])[0]).toEqual([]);
    expect(findHops([column, level(106)])[0]).toHaveLength(1);
  });

  it('skips hops that would run into a rounded corner, without inverting the path', () => {
    const arrows = (y: number): DependencyArrowEdge[] => [
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 162 },
      across('B', y),
    ];
    const plain = routeDependencyArrows([arrows(106)[0]])[0].path;
    // Rounded corners eat 6px at each end, leaving 56..156; a hop needs R + 1 spare on both sides
    for (const y of [52, 56, 60, 60.9, 151.1, 156, 160]) {
      const [down] = routeDependencyArrows(arrows(y));
      expect(down.path, `y=${y}`).toBe(plain);
    }
    for (const y of [61, 151]) {
      const [down] = routeDependencyArrows(arrows(y));
      expect(arcs(down.path), `y=${y}`).toHaveLength(1);
      expectNoInvertedVerticals(down.path);
    }

    // A run too short to fit a hop at all keeps its plain path
    const short = { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 66 };
    for (const y of [54, 58, 62]) {
      const [tight] = routeDependencyArrows([short, across('B', y)]);
      expect(tight.path, `y=${y}`).toBe(routeDependencyArrows([short])[0].path);
    }

    // Sharp corners leave the whole run available
    const [sharp] = routeDependencyArrows(
      [{ sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 66 }, across('B', 58)],
      { cornerRadius: 0 },
    );
    expect(sharp.path).toBe(`M 100 50 H 112 V ${58 - R} A ${R} ${R} 0 0 1 112 ${58 + R} V 66 H 300`);
  });

  it('keeps every hop clear of corners across a sweep of crossing heights', () => {
    for (let y = 50; y <= 220; y += 0.5) {
      for (const sourceY of [50, 218]) {
        const targetY = sourceY === 50 ? 218 : 50;
        const [a] = routeDependencyArrows([
          { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: sourceY, toX: 300, toY: targetY },
          across('B', y),
          across('C', y + 7),
        ]);
        expectNoInvertedVerticals(a.path);
        const pts = points(a.path);
        for (const p of pts) {
          expect(p.y).toBeGreaterThanOrEqual(50);
          expect(p.y).toBeLessThanOrEqual(218);
        }
      }
    }
  });

  it('leaves non-crossing arrows with no hops', () => {
    const routed = routeDependencyArrows([
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 162 },
      across('B', 250),
      { sourceId: 'C', targetId: 'TC', fromX: 500, fromY: 50, toX: 700, toY: 162 },
    ]);
    for (const r of routed) expect(r.path).not.toContain('A ');
  });

  it('crossing arrows keep source, target and offsets of the unhopped routing', () => {
    const edges: DependencyArrowEdge[] = [
      { sourceId: 'A', targetId: 'TA', fromX: 100, fromY: 50, toX: 300, toY: 162 },
      across('B', 106),
    ];
    const [withHop] = routeDependencyArrows(edges);
    const [alone] = routeDependencyArrows([edges[0]]);
    expect(withHop.midXOffset).toBe(alone.midXOffset);
    expect(withHop.laneYOffset).toBe(alone.laneYOffset);
    expect(points(withHop.path)[0]).toEqual({ x: 100, y: 50 });
    expect(points(withHop.path).at(-1)).toEqual({ x: 300, y: 162 });
  });
});
