import { describe, expect, it } from 'vitest';
import {
  assignMilestoneLanes,
  estimateMilestoneWidth,
  isMilestoneLabelFlipped,
  MILESTONE_ROW_HEIGHT,
} from './milestones';

describe('milestones layout utilities', () => {
  it('defines MILESTONE_ROW_HEIGHT as a compact height', () => {
    expect(MILESTONE_ROW_HEIGHT).toBe(44);
  });

  describe('estimateMilestoneWidth', () => {
    it('enforces a minimum width', () => {
      expect(estimateMilestoneWidth('A')).toBe(70);
    });

    it('enforces a maximum width', () => {
      expect(estimateMilestoneWidth('A very long milestone title that goes on and on')).toBe(160);
    });

    it('scales proportionally for medium length titles', () => {
      const width = estimateMilestoneWidth('Beta Release');
      expect(width).toBeGreaterThanOrEqual(70);
      expect(width).toBeLessThanOrEqual(160);
    });
  });

  describe('isMilestoneLabelFlipped', () => {
    it('keeps label on the right when away from the right edge', () => {
      expect(isMilestoneLabelFlipped(100, 1000, 140)).toBe(false);
    });

    it('flips label to the left when near or overflowing the right edge and more room exists on left', () => {
      expect(isMilestoneLabelFlipped(900, 1000, 140)).toBe(true);
      expect(isMilestoneLabelFlipped(861, 1000, 140)).toBe(true);
      expect(isMilestoneLabelFlipped(859, 1000, 140)).toBe(false);
    });

    it('does not flip left if the left side has less space than the right side', () => {
      // Timeline width 200, labelWidth 140. x = 80: x + 140 = 220 > 200, but x (80) <= 200 - 80 (120)
      expect(isMilestoneLabelFlipped(80, 200, 140)).toBe(false);
    });
  });

  describe('assignMilestoneLanes', () => {
    it('returns empty map for empty array', () => {
      const lanes = assignMilestoneLanes([], 30, 1000);
      expect(lanes.size).toBe(0);
    });

    it('assigns single milestone to lane 0', () => {
      const lanes = assignMilestoneLanes([{ id: 'm1', name: 'M1', dayOffset: 5 }], 30, 1000);
      expect(lanes.get('m1')).toBe(0);
    });

    it('keeps sparse milestones on lane 0', () => {
      const lanes = assignMilestoneLanes(
        [
          { id: 'm1', name: 'M1', dayOffset: 5 },
          { id: 'm2', name: 'M2', dayOffset: 25 },
        ],
        30,
        1000,
      );
      expect(lanes.get('m1')).toBe(0);
      expect(lanes.get('m2')).toBe(0);
    });

    it('staggers overlapping milestones across lane 0 and lane 1', () => {
      // dayOffset 5 -> x = 165
      // dayOffset 6 -> x = 195 (overlaps m1 footprint which extends to ~165 + 70 = 235)
      const lanes = assignMilestoneLanes(
        [
          { id: 'm1', name: 'M1', dayOffset: 5 },
          { id: 'm2', name: 'M2', dayOffset: 6 },
        ],
        30,
        1000,
      );
      expect(lanes.get('m1')).toBe(0);
      expect(lanes.get('m2')).toBe(1);
    });

    it('handles same-day milestones by putting them into separate lanes', () => {
      const lanes = assignMilestoneLanes(
        [
          { id: 'm1', name: 'Alpha', dayOffset: 10 },
          { id: 'm2', name: 'Beta', dayOffset: 10 },
        ],
        30,
        1000,
      );
      expect(lanes.get('m1')).toBe(0);
      expect(lanes.get('m2')).toBe(1);
    });

    it('alternates dense milestones when both lanes overlap (month zoom)', () => {
      const milestones = [
        { id: 'm1', name: 'M1', dayOffset: 1 },
        { id: 'm2', name: 'M2', dayOffset: 2 },
        { id: 'm3', name: 'M3', dayOffset: 3 },
        { id: 'm4', name: 'M4', dayOffset: 4 },
      ];
      const lanes = assignMilestoneLanes(milestones, 3, 500);
      expect(lanes.get('m1')).toBe(0);
      expect(lanes.get('m2')).toBe(1);
      expect(lanes.get('m3')).toBe(0);
      expect(lanes.get('m4')).toBe(1);
    });

    it('strictly alternates 0, 1, 0, 1 when dense milestones have mixed label lengths', () => {
      // m1 has a very long label (width 160), m2 has a short label (width 70), m3 and m4 follow closely
      const milestones = [
        { id: 'm1', name: 'Very Long Milestone Name That Takes Max Footprint In Lane Zero', dayOffset: 0 },
        { id: 'm2', name: 'Short', dayOffset: 1 },
        { id: 'm3', name: 'Medium Name', dayOffset: 2 },
        { id: 'm4', name: 'Another Name', dayOffset: 3 },
      ];
      const lanes = assignMilestoneLanes(milestones, 4, 1000);
      expect(lanes.get('m1')).toBe(0);
      expect(lanes.get('m2')).toBe(1);
      expect(lanes.get('m3')).toBe(0);
      expect(lanes.get('m4')).toBe(1);
    });
  });
});
