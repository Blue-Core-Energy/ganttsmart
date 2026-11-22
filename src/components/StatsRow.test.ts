import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task } from '@/types';
import StatsRow from './StatsRow';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'ENG-1',
    uuid: 'uuid-1',
    title: 'Sample task',
    description: '',
    due: '2026-05-10',
    startDate: '2026-05-05',
    priorityVal: 2,
    priority: 'High',
    status: 'Todo',
    statusType: 'unstarted',
    assignee: 'Alice',
    url: 'https://linear.app/test/issue/ENG-1',
    teamId: 'team-1',
    blocks: [],
    blockedBy: [],
    progress: 0,
    totalChildren: 0,
    completedChildren: 0,
    ...overrides,
  };
}

/** Renders StatsRow and returns each card as label -> displayed value, in render order. */
function renderCards(tasks: Task[], unscheduledTasks?: Task[]): [string, string][] {
  const html = renderToStaticMarkup(createElement(StatsRow, { tasks, unscheduledTasks }));
  const texts = [...html.matchAll(/>([^<]+)</g)].map((m) => m[1]);
  const cards: [string, string][] = [];
  for (let i = 0; i + 1 < texts.length; i += 2) cards.push([texts[i + 1], texts[i]]);
  return cards;
}

const unscheduled = (id: string, overrides: Partial<Task> = {}) =>
  makeTask({ id, uuid: `u-${id}`, startDate: null, isDueImplicit: true, ...overrides });

describe('StatsRow', () => {
  const scheduled = [
    makeTask({ id: 'ENG-1', uuid: 'u-1', statusType: 'completed', status: 'Done', due: '2026-05-04' }),
    makeTask({ id: 'ENG-2', uuid: 'u-2', statusType: 'started', status: 'In Progress', due: '2026-05-10' }),
    makeTask({ id: 'ENG-3', uuid: 'u-3', statusType: 'unstarted', due: '2026-05-15' }),
  ];

  it('renders only the Unscheduled card when there are no scheduled issues', () => {
    const cards = renderCards([], [unscheduled('ENG-10'), unscheduled('ENG-11')]);
    expect(cards).toEqual([['Unscheduled', '2']]);
  });

  it('renders every scheduled card plus the unscheduled count when both exist', () => {
    const cards = renderCards(scheduled, [unscheduled('ENG-10'), unscheduled('ENG-11'), unscheduled('ENG-12')]);
    expect(cards).toEqual([
      ['Active', '2'],
      ['In Progress', '1'],
      ['Completed', '1'],
      ['Total Span', '11d'],
      ['Unscheduled', '3'],
    ]);
  });

  it('omits the Unscheduled card when there are no unscheduled issues', () => {
    const labels = renderCards(scheduled, []).map(([label]) => label);
    expect(labels).toEqual(['Active', 'In Progress', 'Completed', 'Total Span']);
    expect(renderCards(scheduled).map(([label]) => label)).not.toContain('Unscheduled');
  });

  it('does not count ignored canceled or duplicate unscheduled issues', () => {
    const cards = renderCards(
      [],
      [
        unscheduled('ENG-10'),
        unscheduled('ENG-11', { status: 'Duplicate', statusType: 'duplicate' }),
        unscheduled('ENG-12', { status: 'Rejected', statusType: 'canceled' }),
      ],
    );
    expect(cards).toEqual([['Unscheduled', '1']]);
  });

  it('omits the Unscheduled card when every unscheduled issue is ignored', () => {
    const cards = renderCards(scheduled, [unscheduled('ENG-10', { status: 'Duplicate', statusType: 'duplicate' })]);
    expect(cards.map(([label]) => label)).not.toContain('Unscheduled');
  });

  it('renders nothing when there are no scheduled and no unscheduled issues', () => {
    expect(renderToStaticMarkup(createElement(StatsRow, { tasks: [], unscheduledTasks: [] }))).toBe('');
    expect(renderToStaticMarkup(createElement(StatsRow, { tasks: [] }))).toBe('');
  });

  it('renders nothing when all issues are ignored', () => {
    const ignored = [makeTask({ status: 'Rejected', statusType: 'canceled' })];
    expect(renderToStaticMarkup(createElement(StatsRow, { tasks: ignored, unscheduledTasks: ignored }))).toBe('');
  });
});
