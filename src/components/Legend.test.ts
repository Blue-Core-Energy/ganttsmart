import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import Legend from './Legend';

describe('Legend', () => {
  const html = renderToStaticMarkup(createElement(Legend));

  it('explains the five schedule states in precedence order, plus today', () => {
    expect(html).toMatch(/Done.*Overdue.*In progress.*Late to start.*Not started.*Today/s);
  });

  it('no longer describes priority', () => {
    for (const priority of ['Urgent', 'High', 'Medium', 'Low', 'None']) {
      expect(html).not.toContain(`>${priority}<`);
    }
  });

  it('draws each swatch from the same classes the bars use', () => {
    for (const state of ['done', 'overdue', 'in-progress', 'late-start', 'not-started']) {
      expect(html).toContain(`bar-swatch bar-${state}`);
    }
    expect(html).not.toContain('linear-gradient');
  });

  it('renders the Today swatch as a soft purple highlight without a dashed line', () => {
    expect(html).not.toContain('dashed');
    expect(html).toContain('bg-accent/20');
  });
});
