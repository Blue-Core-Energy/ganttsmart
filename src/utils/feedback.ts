import { isSafeUrl } from './url';

export type FeedbackType = 'feature' | 'bug';

export const DEFAULT_FEEDBACK_PROJECT_NAME = 'GanttSmart';
export const DEFAULT_FEEDBACK_PROJECT_URL = 'https://linear.app/bluecoreenergy/project/ganttsmart-5114378da6de';
export const DEFAULT_FEEDBACK_TEAM_KEY = 'IT';
export const DEFAULT_FEEDBACK_WORKSPACE_SLUG = 'bluecoreenergy';

export interface FeedbackEnv {
  VITE_FEEDBACK_PROJECT_URL?: string;
  VITE_FEEDBACK_TEAM_KEY?: string;
}

export interface FeedbackConfig {
  projectName: string;
  projectUrl: string;
  projectSlug: string | null;
  projectSlugId: string | null;
  workspaceSlug: string;
  teamKey: string;
  hasCustomProjectUrl: boolean;
}

export interface FeatureFeedbackFields {
  tryingToDo: string;
  gettingInTheWay: string;
  wouldHelp: string;
}

export interface FeedbackAppContext {
  route?: string;
  viewport?: string;
  backendMode?: string;
  projectName?: string;
  userAgent?: string;
}

export interface BugFeedbackFields {
  whatHappened: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  includeContext?: boolean;
  appContext?: FeedbackAppContext;
}

export interface ParsedLinearProjectUrl {
  workspaceSlug: string;
  projectSlug: string;
  projectSlugId: string;
  projectNameHint: string;
}

export function parseLinearProjectUrl(rawUrl: string): ParsedLinearProjectUrl | null {
  if (!isSafeUrl(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    // Expected: /<workspace>/project/<slug>
    const projectIdx = segments.indexOf('project');
    if (projectIdx < 1 || projectIdx + 1 >= segments.length) return null;
    const workspaceSlug = segments[projectIdx - 1];
    const projectSlug = segments[projectIdx + 1];
    const lastDash = projectSlug.lastIndexOf('-');
    const projectSlugId = lastDash > 0 ? projectSlug.slice(lastDash + 1) : projectSlug;
    const projectNameHint = lastDash > 0 ? projectSlug.slice(0, lastDash).replace(/-/g, ' ') : projectSlug;
    return { workspaceSlug, projectSlug, projectSlugId, projectNameHint };
  } catch {
    return null;
  }
}

export function getFeedbackConfig(env?: FeedbackEnv): FeedbackConfig {
  const source: FeedbackEnv = env ?? (import.meta.env as FeedbackEnv);
  const rawUrl = source.VITE_FEEDBACK_PROJECT_URL?.trim();
  const hasCustomProjectUrl = Boolean(rawUrl && isSafeUrl(rawUrl));
  const projectUrl = hasCustomProjectUrl ? rawUrl! : DEFAULT_FEEDBACK_PROJECT_URL;
  const parsed = parseLinearProjectUrl(projectUrl);
  const teamKey = source.VITE_FEEDBACK_TEAM_KEY?.trim() || DEFAULT_FEEDBACK_TEAM_KEY;

  return {
    projectName:
      hasCustomProjectUrl && parsed?.projectNameHint ? parsed.projectNameHint : DEFAULT_FEEDBACK_PROJECT_NAME,
    projectUrl,
    projectSlug: parsed?.projectSlug ?? null,
    projectSlugId: parsed?.projectSlugId ?? null,
    workspaceSlug: parsed?.workspaceSlug ?? DEFAULT_FEEDBACK_WORKSPACE_SLUG,
    teamKey,
    hasCustomProjectUrl,
  };
}

function formatSections(sections: Array<[string, string]>): string {
  const blocks: string[] = [];
  for (const [heading, value] of sections) {
    const trimmed = value.trim();
    if (trimmed) {
      blocks.push(`### ${heading}\n${trimmed}`);
    }
  }
  return blocks.join('\n\n');
}

export function formatFeatureRequestMarkdown(fields: FeatureFeedbackFields): string {
  return formatSections([
    ['What are you trying to do?', fields.tryingToDo],
    ['What gets in the way?', fields.gettingInTheWay],
    ['What would help?', fields.wouldHelp],
  ]);
}

export function formatBugReportMarkdown(fields: BugFeedbackFields): string {
  const body = formatSections([
    ['What happened?', fields.whatHappened],
    ['Steps to reproduce', fields.stepsToReproduce],
    ['Expected behavior', fields.expectedBehavior],
  ]);

  if (!fields.includeContext || !fields.appContext) {
    return body;
  }

  const ctx = fields.appContext;
  const contextLines: string[] = [];
  if (ctx.route) contextLines.push(`- Route: \`${ctx.route}\``);
  if (ctx.viewport) contextLines.push(`- Viewport: ${ctx.viewport}`);
  if (ctx.backendMode) contextLines.push(`- Backend: ${ctx.backendMode}`);
  if (ctx.projectName) contextLines.push(`- Active project: ${ctx.projectName}`);
  if (ctx.userAgent) contextLines.push(`- Browser: ${ctx.userAgent}`);

  if (contextLines.length === 0) return body;

  const contextSection = `### App context\n${contextLines.join('\n')}`;
  return body ? `${body}\n\n${contextSection}` : contextSection;
}

export function collectSafeAppContext(options?: { backendMode?: string; projectName?: string }): FeedbackAppContext {
  const ctx: FeedbackAppContext = {};
  if (typeof window !== 'undefined') {
    ctx.route = window.location.pathname || '/';
    ctx.viewport = `${window.innerWidth}×${window.innerHeight}`;
  }
  if (options?.backendMode) {
    ctx.backendMode = options.backendMode;
  }
  if (options?.projectName) {
    ctx.projectName = options.projectName;
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    ctx.userAgent = navigator.userAgent;
  }
  return ctx;
}

export function buildLinearNewIssueUrl({
  workspaceSlug = DEFAULT_FEEDBACK_WORKSPACE_SLUG,
  teamKey = DEFAULT_FEEDBACK_TEAM_KEY,
  title,
  description,
  labelName,
}: {
  workspaceSlug?: string;
  teamKey?: string;
  title?: string;
  description?: string;
  labelName?: string;
}): string {
  const base = `https://linear.app/${encodeURIComponent(workspaceSlug)}/team/${encodeURIComponent(teamKey)}/new`;
  const params = new URLSearchParams();
  if (title?.trim()) params.set('title', title.trim());
  if (description?.trim()) params.set('description', description.trim());
  if (labelName?.trim()) params.set('labels', labelName.trim());
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function feedbackLabelName(type: FeedbackType): 'Feature' | 'Bug' {
  return type === 'feature' ? 'Feature' : 'Bug';
}
