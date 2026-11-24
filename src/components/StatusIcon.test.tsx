import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import StatusIcon from './StatusIcon';

describe('StatusIcon', () => {
  it('renders completed status as filled check circle', () => {
    const html = renderToStaticMarkup(createElement(StatusIcon, { type: 'completed' }));
    expect(html).toContain('<circle');
    expect(html).toContain('fill="var(--color-success)"');
    expect(html).toContain('<path');
  });

  it('renders started status as half-filled circle', () => {
    const html = renderToStaticMarkup(createElement(StatusIcon, { type: 'started' }));
    expect(html).toContain('<circle');
    expect(html).toContain('<path');
  });

  it('renders backlog status as dashed circle', () => {
    const html = renderToStaticMarkup(createElement(StatusIcon, { type: 'backlog' }));
    expect(html).toContain('stroke-dasharray="2.5 2.5"');
  });

  it('renders canceled status with cross lines', () => {
    const html = renderToStaticMarkup(createElement(StatusIcon, { type: 'canceled' }));
    expect(html).toContain('<line');
  });

  it('renders unstarted as open circle by default', () => {
    const html = renderToStaticMarkup(createElement(StatusIcon, { type: 'unstarted' }));
    expect(html).toContain('<circle');
    expect(html).not.toContain('<path');
    expect(html).not.toContain('stroke-dasharray');
  });

  it('renders duplicate status with diagonal slash', () => {
    const html = renderToStaticMarkup(createElement(StatusIcon, { type: 'duplicate' }));
    expect(html).toContain('<circle');
    expect(html).toContain('<line');
  });

  it('renders triage status with dotted circle', () => {
    const html = renderToStaticMarkup(createElement(StatusIcon, { type: 'triage' }));
    expect(html).toContain('stroke-dasharray="1.5 2"');
  });

  it('uses custom color prop when provided', () => {
    const html = renderToStaticMarkup(createElement(StatusIcon, { type: 'completed', color: '#123456' }));
    expect(html).toContain('fill="#123456"');

    const htmlStroke = renderToStaticMarkup(createElement(StatusIcon, { type: 'unstarted', color: '#abcdef' }));
    expect(htmlStroke).toContain('stroke="#abcdef"');
  });
});
