import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PriorityIcon from './PriorityIcon';

describe('PriorityIcon', () => {
  it('renders urgent priority with exclamation mark in box', () => {
    const html = renderToStaticMarkup(createElement(PriorityIcon, { priority: 'Urgent' }));
    expect(html).toContain('<path');
  });

  it('renders numeric urgent priority 1', () => {
    const html = renderToStaticMarkup(createElement(PriorityIcon, { priority: 1 }));
    expect(html).toContain('<path');
  });

  it('renders high priority with 3 filled bars', () => {
    const html = renderToStaticMarkup(createElement(PriorityIcon, { priority: 'High' }));
    expect(html).toContain('<rect');
    expect(html).not.toContain('opacity="0.25"');
  });

  it('renders medium priority with 2 filled bars and 1 muted bar', () => {
    const html = renderToStaticMarkup(createElement(PriorityIcon, { priority: 'Medium' }));
    const mutedCount = (html.match(/opacity="0\.25"/g) || []).length;
    expect(mutedCount).toBe(1);
    const rectCount = (html.match(/<rect/g) || []).length;
    expect(rectCount).toBe(3);
  });

  it('renders low priority with 1 filled bar and 2 muted bars', () => {
    const html = renderToStaticMarkup(createElement(PriorityIcon, { priority: 'Low' }));
    const mutedCount = (html.match(/opacity="0\.25"/g) || []).length;
    expect(mutedCount).toBe(2);
    const rectCount = (html.match(/<rect/g) || []).length;
    expect(rectCount).toBe(3);
  });

  it('renders none priority with dashes', () => {
    const html = renderToStaticMarkup(createElement(PriorityIcon, { priority: 'None' }));
    expect(html).toContain('opacity="0.4"');
  });
});
