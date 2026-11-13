import { describe, expect, it } from 'vitest';
import {
  buildLinearNewIssueUrl,
  collectSafeAppContext,
  DEFAULT_FEEDBACK_PROJECT_NAME,
  DEFAULT_FEEDBACK_PROJECT_URL,
  DEFAULT_FEEDBACK_TEAM_KEY,
  DEFAULT_FEEDBACK_WORKSPACE_SLUG,
  feedbackLabelName,
  formatBugReportMarkdown,
  formatFeatureRequestMarkdown,
  getFeedbackConfig,
  parseLinearProjectUrl,
} from './feedback';

describe('formatFeatureRequestMarkdown', () => {
  it('formats all three feature prompt sections cleanly', () => {
    const md = formatFeatureRequestMarkdown({
      tryingToDo: '  Export milestone dates  ',
      gettingInTheWay: 'Only PNG and PDF are supported.',
      wouldHelp: 'Add a CSV export option.',
    });

    expect(md).toBe(
      [
        '### What are you trying to do?\nExport milestone dates',
        '### What gets in the way?\nOnly PNG and PDF are supported.',
        '### What would help?\nAdd a CSV export option.',
      ].join('\n\n'),
    );
  });

  it('omits blank sections and returns empty string when all fields are blank', () => {
    expect(
      formatFeatureRequestMarkdown({
        tryingToDo: '   ',
        gettingInTheWay: 'Manual copying takes too long',
        wouldHelp: '',
      }),
    ).toBe('### What gets in the way?\nManual copying takes too long');

    expect(
      formatFeatureRequestMarkdown({
        tryingToDo: '',
        gettingInTheWay: '   ',
        wouldHelp: '\n',
      }),
    ).toBe('');
  });
});

describe('formatBugReportMarkdown', () => {
  it('formats bug sections without context when includeContext is false', () => {
    const md = formatBugReportMarkdown({
      whatHappened: 'Bar jumped to wrong date',
      stepsToReproduce: '1. Drag end handle\n2. Release',
      expectedBehavior: 'Bar snaps to hovered day',
      includeContext: false,
      appContext: {
        route: '/app',
        viewport: '1280×720',
        backendMode: 'gcp',
      },
    });

    expect(md).toBe(
      [
        '### What happened?\nBar jumped to wrong date',
        '### Steps to reproduce\n1. Drag end handle\n2. Release',
        '### Expected behavior\nBar snaps to hovered day',
      ].join('\n\n'),
    );
  });

  it('appends non-sensitive app context when includeContext is true', () => {
    const md = formatBugReportMarkdown({
      whatHappened: 'Chart clipped on narrow screen',
      stepsToReproduce: '',
      expectedBehavior: 'Scrollable horizontally',
      includeContext: true,
      appContext: {
        route: '/app',
        viewport: '375×812',
        backendMode: 'gcp',
        projectName: 'GanttSmart',
        userAgent: 'TestBrowser/1.0',
      },
    });

    expect(md).toBe(
      [
        '### What happened?\nChart clipped on narrow screen',
        '### Expected behavior\nScrollable horizontally',
        '### App context\n- Route: `/app`\n- Viewport: 375×812\n- Backend: gcp\n- Active project: GanttSmart\n- Browser: TestBrowser/1.0',
      ].join('\n\n'),
    );
  });
});

describe('feedback config and URL helpers', () => {
  it('parses standard Linear project URLs', () => {
    expect(parseLinearProjectUrl(DEFAULT_FEEDBACK_PROJECT_URL)).toEqual({
      workspaceSlug: 'bluecoreenergy',
      projectSlug: 'ganttsmart-5114378da6de',
      projectSlugId: '5114378da6de',
      projectNameHint: 'ganttsmart',
    });

    expect(parseLinearProjectUrl('javascript:alert(1)')).toBeNull();
    expect(parseLinearProjectUrl('https://linear.app/bluecoreenergy/team/IT')).toBeNull();
  });

  it('returns default Bluecore Energy config when env overrides are unset', () => {
    expect(getFeedbackConfig({})).toEqual({
      projectName: DEFAULT_FEEDBACK_PROJECT_NAME,
      projectUrl: DEFAULT_FEEDBACK_PROJECT_URL,
      projectSlug: 'ganttsmart-5114378da6de',
      projectSlugId: '5114378da6de',
      workspaceSlug: DEFAULT_FEEDBACK_WORKSPACE_SLUG,
      teamKey: DEFAULT_FEEDBACK_TEAM_KEY,
      hasCustomProjectUrl: false,
    });
  });

  it('respects VITE_FEEDBACK_PROJECT_URL and VITE_FEEDBACK_TEAM_KEY overrides', () => {
    const cfg = getFeedbackConfig({
      VITE_FEEDBACK_PROJECT_URL: 'https://linear.app/acme/project/roadmap-portal-abc123def456',
      VITE_FEEDBACK_TEAM_KEY: 'ENG',
    });

    expect(cfg).toEqual({
      projectName: 'roadmap portal',
      projectUrl: 'https://linear.app/acme/project/roadmap-portal-abc123def456',
      projectSlug: 'roadmap-portal-abc123def456',
      projectSlugId: 'abc123def456',
      workspaceSlug: 'acme',
      teamKey: 'ENG',
      hasCustomProjectUrl: true,
    });
  });

  it('ignores unsafe override URLs and falls back to default project URL', () => {
    const cfg = getFeedbackConfig({
      VITE_FEEDBACK_PROJECT_URL: 'javascript:alert(1)',
      VITE_FEEDBACK_TEAM_KEY: 'OPS',
    });

    expect(cfg.projectUrl).toBe(DEFAULT_FEEDBACK_PROJECT_URL);
    expect(cfg.hasCustomProjectUrl).toBe(false);
    expect(cfg.teamKey).toBe('OPS');
  });

  it('builds pre-filled Linear new-issue URLs', () => {
    const url = buildLinearNewIssueUrl({
      title: 'Add dark mode toggle',
      description: '### What would help?\nA toggle button',
      labelName: feedbackLabelName('feature'),
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://linear.app/bluecoreenergy/team/IT/new');
    expect(parsed.searchParams.get('title')).toBe('Add dark mode toggle');
    expect(parsed.searchParams.get('description')).toBe('### What would help?\nA toggle button');
    expect(parsed.searchParams.get('labels')).toBe('Feature');
  });

  it('collects non-sensitive app context without query strings or tokens', () => {
    const ctx = collectSafeAppContext({ backendMode: 'gcp', projectName: 'Valve Rig' });
    expect(ctx.backendMode).toBe('gcp');
    expect(ctx.projectName).toBe('Valve Rig');
    expect(ctx.route).toBeUndefined();
  });
});
