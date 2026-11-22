import { describe, expect, it } from 'vitest';
import {
  ARROW_DIRECT_MIN_GAP,
  ARROW_LANE_OFFSET,
  ARROW_STAGGER_STEP,
  ARROW_STUB,
  buildArrowPath,
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
  for (const cmd of path.trim().split(/\s(?=[MHVLQ])/)) {
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
