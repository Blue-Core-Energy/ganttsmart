import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import faviconContent from '../../public/favicon.svg?raw';
import AuthPage from './AuthPage';
import Header from './Header';
import Logo, { LogoIcon } from './Logo';
import Landing from '@/pages/Landing';

vi.mock('@/backend', () => ({
  backend: { kind: 'gcp', capabilities: { sharing: false, signOut: true } },
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: 'dark' as const,
    resolved: 'dark' as const,
    setTheme: vi.fn(),
  }),
}));

function parseBarRects(markup: string) {
  const rectMatches = Array.from(markup.matchAll(/<rect\b([^>]*)(?:\/>|>[\s\S]*?<\/rect>)/g));
  return rectMatches.map((match: RegExpMatchArray) => {
    const attrs = match[1] ?? '';
    const x = Number(attrs.match(/\bx="([^"]+)"/)?.[1]);
    const y = Number(attrs.match(/\by="([^"]+)"/)?.[1]);
    const width = Number(attrs.match(/\bwidth="([^"]+)"/)?.[1]);
    const height = Number(attrs.match(/\bheight="([^"]+)"/)?.[1]);
    const rx = Number(attrs.match(/\brx="([^"]+)"/)?.[1]);
    const fill = attrs.match(/\bfill="([^"]+)"/)?.[1];
    return { x, y, width, height, rx, fill };
  });
}

describe('Logo component and Gantt mark geometry', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
  });

  it('renders a crisp presentational tile with an SVG mark', () => {
    const html = renderToStaticMarkup(createElement(Logo));

    expect(html).toContain('data-testid="ganttsmart-logo"');
    expect(html).toContain('bg-accent');
    expect(html).toContain('data-testid="ganttsmart-logo-svg"');
    expect(html).toContain('viewBox="0 0 24 24"');
    // Default size is 28 matching tile and mapping 1:1 without double-padding
    expect(html).toContain('width="28"');
    expect(html).toContain('height="28"');
  });

  it('renders staggered horizontal Gantt bars with no left-aligned identical x', () => {
    const html = renderToStaticMarkup(createElement(LogoIcon));

    const bars = parseBarRects(html);
    expect(bars.length).toBe(3);

    // 1. All bars must have distinct x coordinates (not left-aligned like text/Google Docs)
    const xCoordinates = bars.map((b) => b.x);
    const uniqueX = new Set(xCoordinates);
    expect(uniqueX.size).toBe(bars.length);

    // 2. The bars must form a descending staircase (Gantt schedule timeline: x0 < x1 < x2)
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].x).toBeGreaterThan(bars[i - 1].x);
      expect(bars[i].y).toBeGreaterThan(bars[i - 1].y);
    }

    // 3. Bars should have rounded corners, positive height/width, and white fill
    bars.forEach((bar) => {
      expect(bar.rx).toBeGreaterThan(0);
      expect(bar.fill).toBe('white');
      expect(bar.width).toBeGreaterThan(0);
      expect(bar.height).toBeGreaterThan(0);
    });
  });

  it('supports custom size and scales icon 1:1 to prevent double-padding', () => {
    const html = renderToStaticMarkup(
      createElement(Logo, { size: 40, className: 'custom-class', 'aria-label': 'GanttSmart mark' }),
    );

    expect(html).toContain('custom-class');
    // Maps 1:1 to size 40
    expect(html).toContain('width="40"');
    expect(html).toContain('height="40"');
    // Matches rx 5/24 (~20%) proportion with rounded-lg for size > 32
    expect(html).toContain('rounded-lg');
    // Sets role="img" when aria-label is provided
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="GanttSmart mark"');
  });

  it('allows explicit iconSize override when desired', () => {
    const html = renderToStaticMarkup(createElement(Logo, { size: 40, iconSize: 20 }));

    expect(html).toContain('width="20"');
    expect(html).toContain('height="20"');
  });

  it('is shared and used in Header with GanttSmart casing', () => {
    const headerProps = {
      projectName: 'Test Project',
      loading: false,
      lastSynced: '',
      onRefresh: vi.fn(),
      onDisconnectLinear: vi.fn(),
      onSignOut: vi.fn(),
      theme: 'dark' as const,
      onThemeChange: vi.fn(),
      projectId: 'proj-1',
      projects: [{ id: 'proj-1', name: 'Test Project' }],
      onSelectProject: vi.fn(),
    };

    const html = renderToStaticMarkup(createElement(Header, headerProps));

    // Logo mark present in Header
    expect(html).toContain('data-testid="ganttsmart-logo"');
    // Brand casing must be GanttSmart, never Ganttsmart
    expect(html).toContain('GanttSmart');
    expect(html).not.toContain('Ganttsmart');
  });

  it('is shared and used in Landing with GanttSmart casing', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Landing)));

    // Logo mark present in Landing
    expect(html).toContain('data-testid="ganttsmart-logo"');
    expect(html).toContain('GanttSmart');
    expect(html).not.toContain('Ganttsmart');
  });

  it('is used in AuthPage with GanttSmart heading', () => {
    const authProps = {
      onSignIn: vi.fn(),
      onSignUp: vi.fn(),
      onGoogleSignIn: vi.fn(),
    };

    const html = renderToStaticMarkup(createElement(AuthPage, authProps));

    expect(html).toContain('data-testid="ganttsmart-logo"');
    expect(html).toContain('GanttSmart');
  });
});

describe('public/favicon.svg asset', () => {
  it('uses --color-accent (#5e6ad2) and exact same staggered bar artwork as LogoIcon', () => {
    const svgContent = faviconContent;

    // Accent color requirement
    expect(svgContent).toContain('#5e6ad2');
    expect(svgContent).not.toContain('#58a6ff');

    const allRects = parseBarRects(svgContent);
    // 1 background rounded tile + 3 bars
    expect(allRects.length).toBe(4);

    const tileRect = allRects[0];
    expect(tileRect.width).toBe(24);
    expect(tileRect.height).toBe(24);
    expect(tileRect.fill).toBe('#5e6ad2');

    // Extract the 3 bars from favicon and from LogoIcon
    const faviconBars = allRects.slice(1);
    const componentBars = parseBarRects(renderToStaticMarkup(createElement(LogoIcon)));

    // Directly assert bar coordinates/dimensions match between favicon and LogoIcon to prevent future drift
    expect(faviconBars.length).toBe(componentBars.length);
    for (let i = 0; i < faviconBars.length; i++) {
      expect(faviconBars[i]).toEqual(componentBars[i]);
    }
  });
});
