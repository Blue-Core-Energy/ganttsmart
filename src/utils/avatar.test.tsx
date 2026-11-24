import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Avatar } from './avatar';

describe('Avatar component', () => {
  it('renders initials and hash color for two-word names', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { name: 'Alice Smith', size: 'sm' }));
    expect(html).toContain('>AS<');
    expect(html).toContain('title="Alice Smith"');
    expect(html).toContain('width:20px');
    expect(html).toContain('height:20px');
  });

  it('renders two-letter prefix for single-word names', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { name: 'Bob', size: 'md' }));
    expect(html).toContain('>BO<');
    expect(html).toContain('title="Bob"');
    expect(html).toContain('width:24px');
  });

  it('omits title attribute and renders ? for empty or unassigned names', () => {
    const emptyHtml = renderToStaticMarkup(createElement(Avatar, { name: '' }));
    expect(emptyHtml).toContain('>?<');
    expect(emptyHtml).not.toContain('title=');

    const whitespaceHtml = renderToStaticMarkup(createElement(Avatar, { name: '   ' }));
    expect(whitespaceHtml).toContain('>?<');
    expect(whitespaceHtml).not.toContain('title=');

    const unassignedHtml = renderToStaticMarkup(createElement(Avatar, { name: 'Unassigned' }));
    expect(unassignedHtml).toContain('>?<');
    expect(unassignedHtml).toContain('title="Unassigned"');
  });

  it('applies custom className', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { name: 'Alice', className: 'pointer-events-none' }));
    expect(html).toContain('pointer-events-none');
  });
});
