import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import CustomDropdown from './CustomDropdown';

describe('CustomDropdown', () => {
  const options = [
    { value: 'proj-1', label: 'Alpha Project' },
    { value: 'proj-2', label: 'Beta Project' },
  ];

  it('renders selected option label and listbox ARIA attributes on trigger', () => {
    const html = renderToStaticMarkup(
      createElement(CustomDropdown, {
        value: 'proj-2',
        options,
        placeholder: 'All Projects',
        onChange: vi.fn(),
        required: true,
        searchable: true,
        searchPlaceholder: 'Search projects…',
      }),
    );

    expect(html).toContain('Beta Project');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="listbox"');
  });

  it('renders placeholder when no option matches value', () => {
    const html = renderToStaticMarkup(
      createElement(CustomDropdown, {
        value: '',
        options,
        placeholder: 'All Projects',
        onChange: vi.fn(),
      }),
    );

    expect(html).toContain('All Projects');
  });
});
