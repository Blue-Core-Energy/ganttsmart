import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Avatar } from '@/utils/avatar';
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

  it('still renders the switcher when no project has loaded yet', () => {
    const html = renderToStaticMarkup(createElement(Header, { ...headerProps, projectName: '', projectId: 'proj-9' }));

    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('Select project');
  });

  it('labels the trigger with the loaded project name when the project is not in the list yet', () => {
    const html = renderToStaticMarkup(
      createElement(Header, { ...headerProps, projectName: 'Gamma Controls', projectId: 'proj-9' }),
    );

    expect(html).toMatch(/<button[^>]*aria-haspopup="listbox"[^>]*>.*Gamma Controls.*<\/button>/);
    expect(html).toContain('title="Gamma Controls"');
  });

  it('renders no switcher when there is neither a project name nor any projects', () => {
    const html = renderToStaticMarkup(
      createElement(Header, { ...headerProps, projectName: '', projectId: '', projects: [] }),
    );

    expect(html).not.toContain('aria-haspopup="listbox"');
  });

  it('does not render a "Roadmap" breadcrumb segment next to the project name', () => {
    const html = renderToStaticMarkup(createElement(Header, headerProps));

    expect(html).not.toContain('Roadmap');
    expect(html).not.toMatch(/>\s*Roadmap\s*</);
  });

  it('truncates long project names cleanly in the breadcrumb trigger', () => {
    const longProjectName = 'Enterprise Cloud Infrastructure Platform Migration Initiative 2026';
    const html = renderToStaticMarkup(
      createElement(Header, {
        ...headerProps,
        projectName: longProjectName,
        projectId: 'proj-long',
        projects: [{ id: 'proj-long', name: longProjectName }],
      }),
    );

    expect(html).toContain('min-w-0');
    expect(html).toContain('max-w-[240px]');
    expect(html).toContain('truncate');
    expect(html).toMatch(
      /<span class="truncate">Enterprise Cloud Infrastructure Platform Migration Initiative 2026<\/span>/,
    );
    expect(html).not.toContain('Roadmap');
  });

  it('renders the brand name as "GanttSmart" alongside the Logo mark', () => {
    const html = renderToStaticMarkup(createElement(Header, headerProps));
    expect(html).toContain('GanttSmart');
    expect(html).not.toContain('Ganttsmart');
    expect(html).toContain('data-testid="ganttsmart-logo"');
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
      }),
    );

    expect(html).not.toContain('aria-haspopup="listbox"');
  });
});

describe('Header account button', () => {
  it('renders Avatar with matching initials and color when userName is provided', () => {
    const userName = 'Alice Smith';
    const html = renderToStaticMarkup(createElement(Header, { ...headerProps, userName }));
    const expectedAvatar = renderToStaticMarkup(
      createElement(Avatar, { name: userName, size: 'sm', className: 'pointer-events-none' }),
    );

    expect(html).toContain('title="Account"');
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(expectedAvatar);
    expect(html).toContain('>AS<');
  });

  it('falls back cleanly to ? avatar when userName is omitted', () => {
    const html = renderToStaticMarkup(createElement(Header, headerProps));
    const fallbackAvatar = renderToStaticMarkup(
      createElement(Avatar, { name: '', size: 'sm', className: 'pointer-events-none' }),
    );

    expect(html).toContain('title="Account"');
    expect(html).toContain('aria-label="Account"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(fallbackAvatar);
    expect(html).toContain('>?<');
  });

  it('falls back cleanly to ? avatar when userName is empty or whitespace', () => {
    const emptyHtml = renderToStaticMarkup(createElement(Header, { ...headerProps, userName: '' }));
    const whitespaceHtml = renderToStaticMarkup(createElement(Header, { ...headerProps, userName: '   ' }));
    const fallbackAvatar = renderToStaticMarkup(
      createElement(Avatar, { name: '', size: 'sm', className: 'pointer-events-none' }),
    );

    expect(emptyHtml).toContain(fallbackAvatar);
    expect(emptyHtml).toContain('>?<');
    expect(whitespaceHtml).toContain(fallbackAvatar);
    expect(whitespaceHtml).toContain('>?<');
  });

  it('does not render the legacy SVG person icon', () => {
    const html = renderToStaticMarkup(createElement(Header, { ...headerProps, userName: 'Bob Builder' }));

    expect(html).not.toContain('M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2');
  });
});
