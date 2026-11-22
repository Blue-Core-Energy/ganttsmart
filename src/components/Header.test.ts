import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import FilterBar from './FilterBar';
import Header from './Header';

vi.mock('@/backend', () => ({
  backend: { kind: 'gcp', capabilities: { sharing: false, signOut: true } },
}));

const projects = [
  { id: 'proj-1', name: 'Alpha Platform' },
  { id: 'proj-2', name: 'Beta Mobile' },
];

const headerProps = {
  projectName: 'Beta Mobile',
  loading: false,
  lastSynced: '',
  onRefresh: vi.fn(),
  onDisconnectLinear: vi.fn(),
  onSignOut: vi.fn(),
  theme: 'dark' as const,
  onThemeChange: vi.fn(),
  projectId: 'proj-2',
  projects,
  onSelectProject: vi.fn(),
};

describe('Header project switcher', () => {
  it('renders the breadcrumb project name as a dropdown trigger', () => {
    const html = renderToStaticMarkup(createElement(Header, headerProps));

    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<button[^>]*aria-haspopup="listbox"[^>]*>.*Beta Mobile.*<\/button>/);
  });

  it('renders plain, non-interactive text when hideProjectSelector is set', () => {
    const html = renderToStaticMarkup(createElement(Header, { ...headerProps, hideProjectSelector: true }));

    expect(html).toContain('Beta Mobile');
    expect(html).not.toContain('aria-haspopup="listbox"');
  });
});

describe('FilterBar', () => {
  it('has no project selector', () => {
    const html = renderToStaticMarkup(
      createElement(FilterBar, {
        assignees: [],
        statuses: [],
        filters: { search: '', assignee: '', status: '', dateFrom: '', dateTo: '', showCompleted: true },
        onFiltersChange: vi.fn(),
        totalCount: 0,
        filteredCount: 0,
      }),
    );

    expect(html).not.toContain('aria-haspopup="listbox"');
    expect(html).not.toContain('Search projects');
  });
});
