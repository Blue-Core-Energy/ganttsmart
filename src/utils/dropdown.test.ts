import { describe, expect, it } from 'vitest';
import { filterDropdownOptions, getInitialHighlightIndex, getNextHighlightIndex } from './dropdown';

const SAMPLE_PROJECTS = [
  { value: 'p1', label: 'Alpha Platform' },
  { value: 'p2', label: 'Beta Mobile App' },
  { value: 'p3', label: 'Valve Manifold Rig', keywords: 'hardware ENG' },
  { value: 'p4', label: 'Telemetry Pipeline' },
];

describe('filterDropdownOptions', () => {
  it('returns all options when query is empty or whitespace', () => {
    expect(filterDropdownOptions(SAMPLE_PROJECTS, '')).toEqual(SAMPLE_PROJECTS);
    expect(filterDropdownOptions(SAMPLE_PROJECTS, '   \t\n ')).toEqual(SAMPLE_PROJECTS);
  });

  it('filters case-insensitively by substring', () => {
    expect(filterDropdownOptions(SAMPLE_PROJECTS, 'VALVE').map((o) => o.value)).toEqual(['p3']);
    expect(filterDropdownOptions(SAMPLE_PROJECTS, 'alp').map((o) => o.value)).toEqual(['p1']);
  });

  it('trims surrounding whitespace and matches multiple tokens across the label', () => {
    expect(filterDropdownOptions(SAMPLE_PROJECTS, '  valve rig  ').map((o) => o.value)).toEqual(['p3']);
    expect(filterDropdownOptions(SAMPLE_PROJECTS, 'beta app').map((o) => o.value)).toEqual(['p2']);
  });

  it('matches optional keywords metadata', () => {
    expect(filterDropdownOptions(SAMPLE_PROJECTS, 'hardware').map((o) => o.value)).toEqual(['p3']);
  });

  it('returns empty array when nothing matches or options are empty', () => {
    expect(filterDropdownOptions(SAMPLE_PROJECTS, 'does-not-exist')).toEqual([]);
    expect(filterDropdownOptions([], 'alpha')).toEqual([]);
  });
});

describe('getInitialHighlightIndex', () => {
  it('selects the matching option index when clear option is hidden', () => {
    expect(getInitialHighlightIndex(SAMPLE_PROJECTS, 'p3', false)).toBe(2);
  });

  it('offsets the matching option index by 1 when clear option is shown', () => {
    expect(getInitialHighlightIndex(SAMPLE_PROJECTS, 'p3', true)).toBe(3);
  });

  it('highlights clear option (0) when no value is selected and clear option is shown', () => {
    expect(getInitialHighlightIndex(SAMPLE_PROJECTS, '', true)).toBe(0);
  });

  it('falls back to first option (0) when selected value is filtered out', () => {
    expect(getInitialHighlightIndex([SAMPLE_PROJECTS[0], SAMPLE_PROJECTS[3]], 'p3', false)).toBe(0);
  });

  it('returns -1 when there are no options and no clear option', () => {
    expect(getInitialHighlightIndex([], 'p1', false)).toBe(-1);
  });
});

describe('getNextHighlightIndex', () => {
  it('returns -1 when totalItems is 0 or negative', () => {
    expect(getNextHighlightIndex(0, 0, 'next')).toBe(-1);
    expect(getNextHighlightIndex(-1, 0, 'prev')).toBe(-1);
  });

  it('navigates next with wrap-around', () => {
    expect(getNextHighlightIndex(-1, 4, 'next')).toBe(0);
    expect(getNextHighlightIndex(0, 4, 'next')).toBe(1);
    expect(getNextHighlightIndex(3, 4, 'next')).toBe(0);
  });

  it('navigates prev with wrap-around', () => {
    expect(getNextHighlightIndex(-1, 4, 'prev')).toBe(3);
    expect(getNextHighlightIndex(2, 4, 'prev')).toBe(1);
    expect(getNextHighlightIndex(0, 4, 'prev')).toBe(3);
  });

  it('jumps to first and last', () => {
    expect(getNextHighlightIndex(2, 4, 'first')).toBe(0);
    expect(getNextHighlightIndex(1, 4, 'last')).toBe(3);
  });
});
