import { backend } from '@/backend';
import {
  PRIORITY_MAP,
  type AssignableUser,
  type Milestone,
  type Project,
  type Task,
  type WorkflowState,
} from '@/types';
import { getFeedbackConfig, type FeedbackEnv, type FeedbackType } from '@/utils/feedback';
import { isIgnoredIssueState, type IssueStateLike } from '@/utils/issues';
import { buildProjectDeepLink } from '@/utils/projectDeepLink';
import { sortTasks } from '@/utils/tasks';

// ---- Rate limiter: debounce + queue ----
let pendingRequests = 0;
const MAX_CONCURRENT = 4;
const requestQueue: Array<() => void> = [];

function waitForSlot(): Promise<void> {
  if (pendingRequests < MAX_CONCURRENT) {
    pendingRequests++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    requestQueue.push(() => {
      pendingRequests++;
      resolve();
    });
  });
}

function releaseSlot() {
  pendingRequests--;
  const next = requestQueue.shift();
  if (next) next();
}

/**
 * Fetch rejects with a TypeError on network failures (Chrome: "Failed to fetch",
 * Firefox: "NetworkError when attempting to fetch resource.", Safari: "Load failed").
 * AbortError is explicitly excluded so cancelled requests are never retried.
 */
export function isRetryableNetworkError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  if ((error as { name?: unknown }).name === 'AbortError') return false;
  return error instanceof TypeError || (error instanceof Error && error.name === 'TypeError');
}

// ---- Core GraphQL with retry + rate limit awareness ----
async function gql(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
  retries = 2,
  networkRetries = 1,
): Promise<Record<string, unknown>> {
  await waitForSlot();
  let slotReleased = false;
  const releaseOnce = () => {
    if (!slotReleased) {
      slotReleased = true;
      releaseSlot();
    }
  };

  try {
    const res = await backend.linearRequest(apiKey, { query, variables });

    // Rate limited — retry after delay
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
      if (retries > 0) {
        releaseOnce();
        await delay(retryAfter * 1000);
        return gql(apiKey, query, variables, retries - 1, networkRetries);
      }
      throw new Error('Rate limited by Linear API. Please wait a moment and try again.');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('Linear authentication expired. Please reconnect.');
      if (res.status >= 500 && retries > 0) {
        releaseOnce();
        await delay(1000);
        return gql(apiKey, query, variables, retries - 1, networkRetries);
      }
      throw new Error(`Linear API error (${res.status}): ${text || res.statusText}`);
    }

    const data = await res.json();
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid GraphQL response');
    }
    if ('errors' in data && data.errors) {
      const msg = data.errors[0]?.message || 'Unknown GraphQL error';
      // Retry on transient errors
      if (retries > 0 && (msg.includes('timeout') || msg.includes('unavailable'))) {
        releaseOnce();
        await delay(1000);
        return gql(apiKey, query, variables, retries - 1, networkRetries);
      }
      throw new Error(msg);
    }
    return (data as { data: Record<string, unknown> }).data;
  } catch (e) {
    // Network errors — retry once
    if (networkRetries > 0 && isRetryableNetworkError(e)) {
      releaseOnce();
      await delay(1000);
      return gql(apiKey, query, variables, retries, networkRetries - 1);
    }
    throw e;
  } finally {
    releaseOnce();
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Debounce helper for drag operations ----
const debounceTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; reject: (reason: unknown) => void }>();

class DebounceCancelled extends Error {
  constructor() {
    super('Debounced call was superseded');
    this.name = 'DebounceCancelled';
  }
}

export { DebounceCancelled };

export function debouncedApiCall<T>(key: string, fn: () => Promise<T>, delayMs = 300): Promise<T> {
  return new Promise((resolve, reject) => {
    const existing = debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new DebounceCancelled()); // resolve the orphaned promise
    }

    debounceTimers.set(key, {
      timer: setTimeout(async () => {
        debounceTimers.delete(key);
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      }, delayMs),
      reject,
    });
  });
}

// ---- API functions ----

export async function testAuth(apiKey: string): Promise<{ id: string; name: string }> {
  const data = await gql(apiKey, '{ viewer { id name } }');
  const viewer = data?.viewer as { id: string; name: string } | undefined;
  if (!viewer) throw new Error('Invalid API key');
  return viewer;
}

export async function fetchProjects(apiKey: string): Promise<Project[]> {
  const data = await gql(
    apiKey,
    `query {
      projects(first: 100) {
        nodes { id name }
      }
    }`,
  );
  const projects = data.projects as { nodes: Project[] };
  return projects.nodes.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Schedule dates ----
//
// Linear issues have a native `dueDate` but no native start date and no custom fields, so GanttSmart
// stores schedule dates in a dedicated comment on the issue:
//
//   **GanttSmart Schedule**
//   start: YYYY-MM-DD
//   end: YYYY-MM-DD
//
// Precedence when reading:
//   start: schedule comment `start:` -> legacy `start: DD-MM-YY` / `start: YYYY-MM-DD` in the description.
//   end:   schedule comment `end:` (or `due:`) -> issue.dueDate -> project.targetDate (implicit, caller-side).
//          GanttSmart always writes the comment `end:` and the native `dueDate` together so they normally match.
//          If they differ, someone changed one of them outside GanttSmart; the most recently updated of the
//          schedule comment (`comment.updatedAt`) and the issue (`issue.updatedAt`) wins. This keeps edits made
//          to the due date in Linear's own UI visible without ignoring a deliberately edited schedule comment.
//          This includes clearing the due date in Linear: a null `issue.dueDate` on an issue updated after the comment
//          means the date was removed, so the stale comment `end:` is ignored (the task becomes unscheduled/implicit).
//          Writes update the issue first and the comment second so `comment.updatedAt >= issue.updatedAt` afterwards.
// The legacy description tag is never rewritten; the schedule comment simply takes precedence over it.

/** Max issues per comments query. Keep batch * SCHEDULE_COMMENTS_PER_ISSUE far below Linear's 10,000 limit. */
export const SCHEDULE_COMMENT_BATCH_SIZE = 25;
export const SCHEDULE_COMMENTS_PER_ISSUE = 20;

const SCHEDULE_COMMENT_FILTER = 'GanttSmart schedule';
const SCHEDULE_HEADING_RE = /^\s*(?:\*\*\s*GanttSmart schedule\s*:?\s*\*\*|GanttSmart schedule\s*:)/i;
const DATE_TOKEN = '(?:\\d{4}-\\d{2}-\\d{2}|\\d{2}-\\d{2}-\\d{2})(?!\\d)';

export interface ScheduleCommentNode {
  id: string;
  body: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ParsedScheduleComment {
  id: string;
  startDate: string | null;
  endDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ResolvedSchedule {
  startDate: string | null;
  dueDate: string | null;
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parse `YYYY-MM-DD` or legacy `DD-MM-YY` into `YYYY-MM-DD`. */
function parseDateToken(raw: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return toIsoDate(parseInt(iso[1], 10), parseInt(iso[2], 10), parseInt(iso[3], 10));
  const legacy = /^(\d{2})-(\d{2})-(\d{2})$/.exec(raw);
  if (legacy) return toIsoDate(2000 + parseInt(legacy[3], 10), parseInt(legacy[2], 10), parseInt(legacy[1], 10));
  return null;
}

/** Parse `start: YYYY-MM-DD` or legacy `start: DD-MM-YY` from an issue description. */
export function parseStartDate(description: string): string | null {
  const match = new RegExp(`start:\\s*(${DATE_TOKEN})`, 'i').exec(description);
  return match ? parseDateToken(match[1]) : null;
}

/** Parse a GanttSmart schedule comment body. Returns null if it is not a schedule comment or has no valid date. */
export function parseScheduleComment(body: string): { startDate: string | null; endDate: string | null } | null {
  const text = body.replace(/\\(?=[-_*])/g, '');
  if (!SCHEDULE_HEADING_RE.test(text)) return null;
  const read = (key: string): string | null => {
    const match = new RegExp(`^[ \\t>*-]*${key}[ \\t]*:[ \\t]*(${DATE_TOKEN})[ \\t*]*$`, 'im').exec(text);
    return match ? parseDateToken(match[1]) : null;
  };
  const startDate = read('start');
  const endDate = read('end') ?? read('due');
  if (!startDate && !endDate) return null;
  return { startDate, endDate };
}

export function formatScheduleComment(schedule: { startDate?: string | null; dueDate?: string | null }): string {
  const lines = ['**GanttSmart Schedule**'];
  if (schedule.startDate) lines.push(`start: ${schedule.startDate}`);
  if (schedule.dueDate) lines.push(`end: ${schedule.dueDate}`);
  return lines.join('\n');
}

function timeOf(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Latest valid schedule comment (by updatedAt, then createdAt, then position) among an issue's comments. */
export function pickScheduleComment(comments: ScheduleCommentNode[]): ParsedScheduleComment | null {
  let best: ParsedScheduleComment | null = null;
  for (const c of comments) {
    if (!c || typeof c.body !== 'string') continue;
    const parsed = parseScheduleComment(c.body);
    if (!parsed) continue;
    const candidate: ParsedScheduleComment = {
      id: c.id,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      createdAt: c.createdAt ?? null,
      updatedAt: c.updatedAt ?? null,
    };
    if (!best) {
      best = candidate;
      continue;
    }
    const bestKey = [timeOf(best.updatedAt || best.createdAt), timeOf(best.createdAt)];
    const key = [timeOf(candidate.updatedAt || candidate.createdAt), timeOf(candidate.createdAt)];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] >= bestKey[1])) best = candidate;
  }
  return best;
}

/** Combine the schedule comment, native dueDate and legacy description tag into one schedule (see precedence above). */
export function resolveIssueSchedule(input: {
  description?: string | null;
  dueDate?: string | null;
  issueUpdatedAt?: string | null;
  comment?: ParsedScheduleComment | null;
}): ResolvedSchedule {
  const { comment } = input;
  const nativeDue = input.dueDate || null;
  const startDate = comment?.startDate ?? parseStartDate(input.description || '');

  let dueDate = nativeDue;
  if (comment?.endDate) {
    const commentStamp = comment.updatedAt || comment.createdAt;
    const issueIsNewer =
      Boolean(commentStamp) && Boolean(input.issueUpdatedAt) && timeOf(input.issueUpdatedAt) > timeOf(commentStamp);
    if (issueIsNewer && nativeDue === null) {
      // dueDate was cleared in Linear after the schedule comment was written
      dueDate = null;
    } else if (issueIsNewer && nativeDue !== comment.endDate) {
      dueDate = nativeDue;
    } else {
      dueDate = comment.endDate;
    }
  }
  return { startDate, dueDate };
}

const SCHEDULE_COMMENTS_FIELDS = `comments(first: ${SCHEDULE_COMMENTS_PER_ISSUE}, orderBy: updatedAt, filter: { body: { containsIgnoreCase: "${SCHEDULE_COMMENT_FILTER}" } }) {
        nodes { id body createdAt updatedAt }
      }`;

export const SCHEDULE_COMMENTS_QUERY = `query ScheduleComments($ids: [ID!]!) {
  issues(first: ${SCHEDULE_COMMENT_BATCH_SIZE}, filter: { id: { in: $ids } }) {
    nodes {
      id
      updatedAt
      ${SCHEDULE_COMMENTS_FIELDS}
    }
  }
}`;

export const ISSUE_SCHEDULE_QUERY = `query IssueSchedule($id: String!) {
  issue(id: $id) {
    description
    dueDate
    updatedAt
    ${SCHEDULE_COMMENTS_FIELDS}
  }
}`;

interface IssueScheduleSource {
  comment: ParsedScheduleComment | null;
  issueUpdatedAt: string | null;
}

/** Fetch schedule comments in small batches so each request stays far below Linear's 10,000 complexity limit. */
async function fetchScheduleSources(apiKey: string, issueIds: string[]): Promise<Map<string, IssueScheduleSource>> {
  const sources = new Map<string, IssueScheduleSource>();
  const batches: string[][] = [];
  for (let i = 0; i < issueIds.length; i += SCHEDULE_COMMENT_BATCH_SIZE) {
    batches.push(issueIds.slice(i, i + SCHEDULE_COMMENT_BATCH_SIZE));
  }
  await Promise.all(
    batches.map(async (ids) => {
      try {
        const data = await gql(apiKey, SCHEDULE_COMMENTS_QUERY, { ids });
        const nodes =
          (
            data.issues as
              | {
                  nodes?: Array<{
                    id: string;
                    updatedAt?: string | null;
                    comments?: { nodes?: ScheduleCommentNode[] } | null;
                  }>;
                }
              | undefined
          )?.nodes ?? [];
        for (const node of nodes) {
          sources.set(node.id, {
            comment: pickScheduleComment(node.comments?.nodes ?? []),
            issueUpdatedAt: node.updatedAt ?? null,
          });
        }
      } catch {
        console.warn('Failed to fetch schedule comments — falling back to descriptions and due dates');
      }
    }),
  );
  return sources;
}

export async function fetchIssues(
  apiKey: string,
  projectId: string,
): Promise<{
  projectName: string;
  tasks: Task[];
  unscheduledTasks: Task[];
  externalTasks: Task[];
  externalUnscheduledTasks: Task[];
  milestones: Milestone[];
}> {
  const data = await gql(
    apiKey,
    `query($id: String!) {
      project(id: $id) {
        name
        startDate
        targetDate
        projectMilestones {
          nodes {
            id
            name
            description
            targetDate
            sortOrder
            createdAt
            updatedAt
          }
        }
        issues(first: 250, filter: { completedAt: { null: true }, canceledAt: { null: true } }) {
          nodes {
            id
            identifier
            title
            description
            dueDate
            url
            priority
            state { name type }
            createdAt
            completedAt
            canceledAt
            assignee { id name }
            team { id }
            projectMilestone { id }
            parent { identifier }
          }
        }
        doneIssues: issues(first: 100, filter: { completedAt: { null: false }, canceledAt: { null: true } }) {
          nodes {
            id
            identifier
            title
            description
            dueDate
            url
            priority
            state { name type }
            createdAt
            completedAt
            canceledAt
            assignee { id name }
            team { id }
            projectMilestone { id }
            parent { identifier }
          }
        }
      }
    }`,
    { id: projectId },
  );

  interface IssueNode {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    dueDate: string | null;
    url: string;
    priority: number;
    state: { name: string; type: string } | null;
    createdAt: string;
    completedAt: string | null;
    canceledAt?: string | null;
    assignee: { id?: string; name: string } | null;
    team: { id: string } | null;
    projectMilestone: { id: string } | null;
    parent?: { identifier: string } | null;
  }

  interface MilestoneNode {
    id: string;
    name: string;
    description: string | null;
    targetDate: string | null;
    sortOrder: number | null;
    createdAt: string | null;
    updatedAt: string | null;
  }

  const project = data.project as {
    name: string;
    startDate: string | null;
    targetDate: string | null;
    projectMilestones: { nodes: MilestoneNode[] };
    issues: { nodes: IssueNode[] };
    doneIssues: { nodes: IssueNode[] };
  };

  if (!project) throw new Error('Project not found');

  const ignoredIdentifiers = new Set<string>();
  const issueNodes: IssueNode[] = [];
  for (const n of project.issues.nodes) {
    if (isIgnoredIssueState(n.state, n.canceledAt)) {
      ignoredIdentifiers.add(n.identifier);
    } else {
      issueNodes.push(n);
    }
  }

  const doneIssueNodes: IssueNode[] = [];
  for (const n of project.doneIssues?.nodes || []) {
    if (isIgnoredIssueState(n.state, n.canceledAt)) {
      ignoredIdentifiers.add(n.identifier);
    } else {
      doneIssueNodes.push(n);
    }
  }
  const projectTargetDate = project.targetDate;

  // Effective due date: explicit dueDate, falling back to project's targetDate.
  // Returns { date, isImplicit } or null if no date can be derived at all.
  function effectiveDue(n: IssueNode): { date: string; isImplicit: boolean } | null {
    const dueDate = scheduleOf(n).dueDate;
    if (dueDate) return { date: dueDate, isImplicit: false };
    if (projectTargetDate) return { date: projectTargetDate, isImplicit: true };
    return null;
  }

  // Query 2: fetch relations and children for all scheduled/unscheduled issues (active + completed).
  // We want relation/child counts on every issue so dependencies and progress work across all tasks.
  // Also collect full metadata for cross-project related issues in the same query (zero extra requests).
  const issueIds = [...new Set([...issueNodes, ...doneIssueNodes].map((n) => n.id))];
  const localIssueUuids = new Set(issueIds);

  const relationsMap: Record<string, { blocks: string[]; blockedBy: string[] }> = {};
  const childrenMap: Record<string, { total: number; completed: number }> = {};

  interface ExternalCandidate {
    node: {
      id: string;
      identifier: string;
      title: string;
      description?: string | null;
      dueDate?: string | null;
      url?: string;
      priority?: number;
      completedAt?: string | null;
      canceledAt?: string | null;
      state?: { name?: string | null; type?: string | null } | null;
      assignee?: { id?: string; name: string } | null;
      team?: { id: string } | null;
      project?: { id: string; name: string; targetDate?: string | null } | null;
    };
    blocksLocalIds: Set<string>;
    blockedByLocalIds: Set<string>;
  }
  const externalCandidates = new Map<string, ExternalCandidate>();

  if (issueIds.length > 0) {
    try {
      interface RelNode {
        type: string;
        relatedIssue: {
          id?: string;
          identifier: string;
          title?: string;
          description?: string | null;
          dueDate?: string | null;
          url?: string;
          priority?: number;
          completedAt?: string | null;
          canceledAt?: string | null;
          state?: IssueStateLike | null;
          assignee?: { id?: string; name: string } | null;
          team?: { id: string } | null;
          project?: { id: string; name: string; targetDate?: string | null } | null;
        };
      }
      interface ChildNode {
        id: string;
        completedAt: string | null;
        canceledAt?: string | null;
        state?: IssueStateLike | null;
      }

      for (let i = 0; i < issueIds.length; i += 250) {
        const batchIds = issueIds.slice(i, i + 250);
        const detailData = await gql(
          apiKey,
          `query($ids: [ID!]!) {
            issues(first: 250, filter: { id: { in: $ids } }) {
              nodes {
                id
                identifier
                relations {
                  nodes {
                    type
                    relatedIssue {
                      id
                      identifier
                      title
                      description
                      dueDate
                      url
                      priority
                      completedAt
                      canceledAt
                      state { name type }
                      assignee { id name }
                      team { id }
                      project {
                        id
                        name
                        targetDate
                      }
                    }
                  }
                }
                children {
                  nodes {
                    id
                    completedAt
                    canceledAt
                    state { name type }
                  }
                }
              }
            }
          }`,
          { ids: batchIds },
        );

        const issues = detailData.issues as {
          nodes: Array<{
            id: string;
            identifier: string;
            relations?: { nodes: RelNode[] };
            children?: { nodes: ChildNode[] };
          }>;
        };

        for (const node of issues.nodes) {
          const identifier = node.identifier;
          const relations = node.relations?.nodes || [];
          const blocks: string[] = [];
          const blockedBy: string[] = [];
          for (const rel of relations) {
            const relType = rel.type?.toLowerCase();
            if (relType === 'duplicate') {
              // Issue has an outgoing duplicate relation ("this issue is a duplicate of relatedIssue")
              ignoredIdentifiers.add(identifier);
              continue;
            }
            if (
              ignoredIdentifiers.has(rel.relatedIssue.identifier) ||
              isIgnoredIssueState(rel.relatedIssue.state, rel.relatedIssue.canceledAt)
            ) {
              ignoredIdentifiers.add(rel.relatedIssue.identifier);
              continue;
            }
            if (relType === 'blocks') blocks.push(rel.relatedIssue.identifier);
            else if (relType === 'blocked_by') blockedBy.push(rel.relatedIssue.identifier);

            if (
              (relType === 'blocks' || relType === 'blocked_by') &&
              rel.relatedIssue.id &&
              typeof rel.relatedIssue.title === 'string' &&
              !localIssueUuids.has(rel.relatedIssue.id) &&
              rel.relatedIssue.project?.id !== projectId
            ) {
              let entry = externalCandidates.get(rel.relatedIssue.id);
              if (!entry) {
                entry = {
                  node: {
                    id: rel.relatedIssue.id,
                    identifier: rel.relatedIssue.identifier,
                    title: rel.relatedIssue.title,
                    description: rel.relatedIssue.description,
                    dueDate: rel.relatedIssue.dueDate,
                    url: rel.relatedIssue.url,
                    priority: rel.relatedIssue.priority,
                    completedAt: rel.relatedIssue.completedAt,
                    canceledAt: rel.relatedIssue.canceledAt,
                    state: rel.relatedIssue.state,
                    assignee: rel.relatedIssue.assignee,
                    team: rel.relatedIssue.team,
                    project: rel.relatedIssue.project,
                  },
                  blocksLocalIds: new Set<string>(),
                  blockedByLocalIds: new Set<string>(),
                };
                externalCandidates.set(rel.relatedIssue.id, entry);
              }
              if (relType === 'blocked_by') {
                // Local issue is blocked by this external issue -> external blocks local
                entry.blocksLocalIds.add(identifier);
              } else {
                // Local issue blocks this external issue -> external is blocked by local
                entry.blockedByLocalIds.add(identifier);
              }
            }
          }
          relationsMap[identifier] = { blocks, blockedBy };

          const children = (node.children?.nodes || []).filter((c) => !isIgnoredIssueState(c.state, c.canceledAt));
          childrenMap[identifier] = {
            total: children.length,
            completed: children.filter((c) => c.completedAt !== null).length,
          };
        }
      }

      // Remove references to any issues discovered to be duplicates in Query 2
      if (ignoredIdentifiers.size > 0) {
        for (const rel of Object.values(relationsMap)) {
          rel.blocks = rel.blocks.filter((id) => !ignoredIdentifiers.has(id));
          rel.blockedBy = rel.blockedBy.filter((id) => !ignoredIdentifiers.has(id));
        }
        for (const [extUuid, entry] of externalCandidates.entries()) {
          if (ignoredIdentifiers.has(entry.node.identifier)) {
            externalCandidates.delete(extUuid);
            continue;
          }
          for (const ignoredId of ignoredIdentifiers) {
            entry.blocksLocalIds.delete(ignoredId);
            entry.blockedByLocalIds.delete(ignoredId);
          }
          if (entry.blocksLocalIds.size === 0 && entry.blockedByLocalIds.size === 0) {
            externalCandidates.delete(extUuid);
          }
        }
      }
    } catch {
      console.warn('Failed to fetch relations/children — continuing without them');
    }
  }

  const scheduleIds = [
    ...new Set([
      ...issueNodes.filter((n) => !ignoredIdentifiers.has(n.identifier)).map((n) => n.id),
      ...doneIssueNodes.filter((n) => !ignoredIdentifiers.has(n.identifier)).map((n) => n.id),
      ...[...externalCandidates.values()]
        .filter((e) => !ignoredIdentifiers.has(e.node.identifier))
        .map((e) => e.node.id),
    ]),
  ];
  const scheduleSources = scheduleIds.length > 0 ? await fetchScheduleSources(apiKey, scheduleIds) : new Map();

  function scheduleOf(n: { id: string; description?: string | null; dueDate?: string | null }): ResolvedSchedule {
    const source = scheduleSources.get(n.id);
    return resolveIssueSchedule({
      description: n.description,
      dueDate: n.dueDate,
      issueUpdatedAt: source?.issueUpdatedAt,
      comment: source?.comment,
    });
  }

  const activeIssueNodes =
    ignoredIdentifiers.size > 0 ? issueNodes.filter((n) => !ignoredIdentifiers.has(n.identifier)) : issueNodes;
  const activeDoneIssueNodes =
    ignoredIdentifiers.size > 0 ? doneIssueNodes.filter((n) => !ignoredIdentifiers.has(n.identifier)) : doneIssueNodes;

  function mapNode(n: IssueNode, due: string, isDueImplicit: boolean): Task {
    const rel = relationsMap[n.identifier] || { blocks: [], blockedBy: [] };
    const ch = childrenMap[n.identifier] || { total: 0, completed: 0 };
    const progress = ch.total > 0 ? Math.round((ch.completed / ch.total) * 100) : 0;

    return {
      id: n.identifier,
      uuid: n.id,
      title: n.title,
      description: n.description || '',
      due,
      startDate: scheduleOf(n).startDate,
      url: n.url,
      priorityVal: n.priority,
      priority: PRIORITY_MAP[n.priority] || 'None',
      status: n.state?.name || '',
      statusType: n.state?.type || '',
      assignee: n.assignee?.name || 'Unassigned',
      assigneeId: n.assignee?.id ?? null,
      teamId: n.team?.id || '',
      blocks: rel.blocks,
      blockedBy: rel.blockedBy,
      progress,
      totalChildren: ch.total,
      completedChildren: ch.completed,
      completedAt: n.completedAt || undefined,
      isDueImplicit: isDueImplicit || undefined,
      milestoneId: n.projectMilestone?.id ?? null,
      parentId: n.parent?.identifier ?? null,
    };
  }

  // Unify active scheduled issues and completed scheduled issues into a single tasks list
  // so completed work appears inline in context with remaining work.
  const tasks: Task[] = [];
  const unscheduledTasks: Task[] = [];
  const seenUuids = new Set<string>();

  for (const n of activeIssueNodes) {
    seenUuids.add(n.id);
    const eff = effectiveDue(n);
    if (eff) {
      tasks.push(mapNode(n, eff.date, eff.isImplicit));
    } else {
      // No date — show as unscheduled with a placeholder due date (today) so consumers
      // that need `due` can render. UI treats these specially via isDueImplicit.
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      unscheduledTasks.push(mapNode(n, todayStr, true));
    }
  }

  for (const n of activeDoneIssueNodes) {
    if (seenUuids.has(n.id)) continue;
    const eff = effectiveDue(n);
    if (eff) {
      seenUuids.add(n.id);
      tasks.push(mapNode(n, eff.date, eff.isImplicit));
    }
  }

  const sortedTasks = sortTasks(tasks);
  unscheduledTasks.sort((a, b) => a.priorityVal - b.priorityVal || a.id.localeCompare(b.id));

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const externalTasks: Task[] = [];
  const externalUnscheduledTasks: Task[] = [];

  for (const entry of externalCandidates.values()) {
    const ext = entry.node;
    if (seenUuids.has(ext.id) || ignoredIdentifiers.has(ext.identifier)) continue;

    const extTargetDate = ext.project?.targetDate || null;
    const extSchedule = scheduleOf(ext);
    const due = extSchedule.dueDate || extTargetDate || todayStr;
    const isDueImplicit = !extSchedule.dueDate;
    const isUnscheduledExternal = !extSchedule.dueDate && !extTargetDate;
    const priorityVal = typeof ext.priority === 'number' ? ext.priority : 0;

    const extTask: Task = {
      id: ext.identifier,
      uuid: ext.id,
      title: ext.title,
      description: ext.description || '',
      due,
      startDate: extSchedule.startDate,
      url: ext.url || '',
      priorityVal,
      priority: PRIORITY_MAP[priorityVal] || 'None',
      status: ext.state?.name || '',
      statusType: ext.state?.type || '',
      assignee: ext.assignee?.name || 'Unassigned',
      assigneeId: ext.assignee?.id ?? null,
      teamId: ext.team?.id || '',
      blocks: [...entry.blocksLocalIds],
      blockedBy: [...entry.blockedByLocalIds],
      progress: 0,
      totalChildren: 0,
      completedChildren: 0,
      completedAt: ext.completedAt || undefined,
      isDueImplicit: isDueImplicit || undefined,
      milestoneId: null,
      projectId: ext.project?.id ?? null,
      projectName: ext.project?.name || 'No Project',
      isExternal: true,
      isUnscheduledExternal: isUnscheduledExternal || undefined,
    };

    if (isUnscheduledExternal) {
      externalUnscheduledTasks.push(extTask);
    } else {
      externalTasks.push(extTask);
    }
  }

  const sortedExternalTasks = sortTasks(externalTasks);
  externalUnscheduledTasks.sort((a, b) => a.priorityVal - b.priorityVal || a.id.localeCompare(b.id));

  const milestones: Milestone[] = (project.projectMilestones?.nodes || [])
    .map((m) => ({
      id: m.id,
      name: m.name,
      targetDate: m.targetDate,
      description: m.description || undefined,
      sortOrder: m.sortOrder ?? undefined,
      createdAt: m.createdAt || undefined,
      updatedAt: m.updatedAt || undefined,
    }))
    .sort((a, b) => {
      // Chronological where possible; undated milestones last, then by sortOrder
      if (a.targetDate && b.targetDate) return a.targetDate.localeCompare(b.targetDate);
      if (a.targetDate) return -1;
      if (b.targetDate) return 1;
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    });

  return {
    projectName: project.name,
    tasks: sortedTasks,
    unscheduledTasks,
    externalTasks: sortedExternalTasks,
    externalUnscheduledTasks,
    milestones,
  };
}

// ---- Mutations (with debouncing for drag operations) ----

// Schedule writes for the same issue are chained so concurrent updates (e.g. moving a bar changes both
// start and due date) each read the comment written by the previous one instead of creating duplicates.
const scheduleWriteQueues = new Map<string, Promise<unknown>>();

function enqueueScheduleWrite<T>(issueId: string, fn: () => Promise<T>): Promise<T> {
  const previous = scheduleWriteQueues.get(issueId) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const tail = result.catch(() => {});
  scheduleWriteQueues.set(issueId, tail);
  void tail.then(() => {
    if (scheduleWriteQueues.get(issueId) === tail) scheduleWriteQueues.delete(issueId);
  });
  return result;
}

/**
 * Write schedule dates to the issue's GanttSmart schedule comment (updated in place when one exists,
 * created otherwise). The date not being changed is preserved from the existing comment, native dueDate
 * or legacy description tag. A new due date is also written to Linear's native `dueDate`.
 */
function writeIssueSchedule(
  apiKey: string,
  issueId: string,
  patch: { startDate?: string; dueDate?: string },
): Promise<void> {
  return enqueueScheduleWrite(issueId, async () => {
    const data = await gql(apiKey, ISSUE_SCHEDULE_QUERY, { id: issueId });
    const issue = data.issue as {
      description?: string | null;
      dueDate?: string | null;
      updatedAt?: string | null;
      comments?: { nodes?: ScheduleCommentNode[] } | null;
    } | null;
    if (!issue) throw new Error('Linear issue not found.');

    const existing = pickScheduleComment(issue.comments?.nodes ?? []);
    const current = resolveIssueSchedule({
      description: issue.description,
      dueDate: issue.dueDate,
      issueUpdatedAt: issue.updatedAt,
      comment: existing,
    });
    const body = formatScheduleComment({
      startDate: patch.startDate ?? current.startDate,
      dueDate: patch.dueDate ?? current.dueDate,
    });

    // Write the native dueDate before the comment so the comment is never older than the issue.
    if (patch.dueDate) {
      await gql(
        apiKey,
        `mutation($id: String!, $dueDate: TimelessDate!) {
          issueUpdate(id: $id, input: { dueDate: $dueDate }) {
            success
          }
        }`,
        { id: issueId, dueDate: patch.dueDate },
      );
    }

    if (existing) {
      const res = await gql(
        apiKey,
        `mutation($commentId: String!, $body: String!) {
          commentUpdate(id: $commentId, input: { body: $body }) {
            success
          }
        }`,
        { commentId: existing.id, body },
      );
      if ((res.commentUpdate as { success?: boolean } | undefined)?.success === false) {
        throw new Error('Linear did not confirm schedule comment update.');
      }
    } else {
      const res = await gql(
        apiKey,
        `mutation($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
          }
        }`,
        { issueId, body },
      );
      if ((res.commentCreate as { success?: boolean } | undefined)?.success === false) {
        throw new Error('Linear did not confirm schedule comment creation.');
      }
    }
  });
}

export async function updateIssueDueDate(apiKey: string, issueId: string, dueDate: string): Promise<void> {
  await debouncedApiCall(`due-${issueId}`, () => writeIssueSchedule(apiKey, issueId, { dueDate }));
}

export async function updateIssueStartDate(apiKey: string, issueId: string, startDate: string): Promise<void> {
  await debouncedApiCall(`start-${issueId}`, () => writeIssueSchedule(apiKey, issueId, { startDate }));
}

/** Move a project milestone's target date. Debounced — driven by dragging on the chart. */
export async function updateMilestoneTargetDate(
  apiKey: string,
  milestoneId: string,
  targetDate: string,
): Promise<void> {
  await debouncedApiCall(`milestone-${milestoneId}`, () =>
    gql(
      apiKey,
      `mutation($id: String!, $targetDate: TimelessDate!) {
        projectMilestoneUpdate(id: $id, input: { targetDate: $targetDate }) {
          success
        }
      }`,
      { id: milestoneId, targetDate },
    ),
  );
}

export async function updateIssueState(apiKey: string, issueId: string, stateId: string): Promise<void> {
  const data = await gql(
    apiKey,
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }`,
    { id: issueId, stateId },
  );
  const res = data.issueUpdate as { success?: boolean } | undefined;
  if (res && res.success === false) {
    throw new Error('Linear did not confirm issue status update.');
  }
}

export async function updateIssueAssignee(apiKey: string, issueId: string, assigneeId: string | null): Promise<void> {
  const data = await gql(
    apiKey,
    `mutation($id: String!, $assigneeId: String) {
      issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
        success
      }
    }`,
    { id: issueId, assigneeId },
  );
  const res = data.issueUpdate as { success?: boolean } | undefined;
  if (res && res.success === false) {
    throw new Error('Linear did not confirm issue assignee update.');
  }
}

export async function updateIssueTitle(apiKey: string, issueId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('Issue title cannot be empty.');
  const data = await gql(
    apiKey,
    `mutation($id: String!, $title: String!) {
      issueUpdate(id: $id, input: { title: $title }) {
        success
      }
    }`,
    { id: issueId, title: trimmed },
  );
  const res = data.issueUpdate as { success?: boolean } | undefined;
  if (res && res.success === false) {
    throw new Error('Linear did not confirm issue title update.');
  }
}

const ASSIGNABLE_USERS_PAGE_SIZE = 100;
const ASSIGNABLE_USERS_MAX_PAGES = 5;
const WORKSPACE_USERS_KEY = '__workspace__';
const assignableUsersCache = new Map<string, Promise<AssignableUser[]>>();
let assignableUsersCacheToken: string | null = null;

interface UserNode {
  id: string;
  name?: string | null;
  displayName?: string | null;
  active?: boolean | null;
}

interface UserConnection {
  nodes?: UserNode[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

/** Drop deactivated users and sort by name; every query selects only scalar fields to stay far below Linear's complexity limit. */
function toAssignableUsers(nodes: UserNode[]): AssignableUser[] {
  const seen = new Set<string>();
  const users: AssignableUser[] = [];
  for (const n of nodes) {
    if (!n?.id || n.active === false || seen.has(n.id)) continue;
    seen.add(n.id);
    const name = n.name || n.displayName || 'Unknown';
    users.push({ id: n.id, name, displayName: n.displayName || name });
  }
  return users.sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchAssignableUsersUncached(apiKey: string, teamId: string): Promise<AssignableUser[]> {
  const nodes: UserNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < ASSIGNABLE_USERS_MAX_PAGES; page++) {
    const data: Record<string, unknown> = teamId
      ? await gql(
          apiKey,
          `query($teamId: String!, $after: String) {
            team(id: $teamId) {
              members(first: ${ASSIGNABLE_USERS_PAGE_SIZE}, after: $after) {
                nodes { id name displayName active }
                pageInfo { hasNextPage endCursor }
              }
            }
          }`,
          { teamId, after },
        )
      : await gql(
          apiKey,
          `query($after: String) {
            users(first: ${ASSIGNABLE_USERS_PAGE_SIZE}, after: $after, filter: { active: { eq: true } }) {
              nodes { id name displayName active }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { after },
        );
    const connection = (
      teamId ? (data.team as { members?: UserConnection } | null)?.members : (data.users as UserConnection | undefined)
    ) as UserConnection | undefined;
    nodes.push(...(connection?.nodes ?? []));
    const next: string | null | undefined = connection?.pageInfo?.endCursor;
    if (!connection?.pageInfo?.hasNextPage || !next) break;
    after = next;
  }
  return toAssignableUsers(nodes);
}

/**
 * Active users that can be assigned to an issue: the members of the issue's team, or all active
 * workspace users when the team is unknown. Cached per team for the session; failures are not cached.
 * The cache belongs to one token, so switching workspaces in the same tab never shows a stale list.
 */
export function fetchAssignableUsers(apiKey: string, teamId: string): Promise<AssignableUser[]> {
  if (assignableUsersCacheToken !== apiKey) {
    assignableUsersCache.clear();
    assignableUsersCacheToken = apiKey;
  }
  const key = teamId || WORKSPACE_USERS_KEY;
  const cached = assignableUsersCache.get(key);
  if (cached) return cached;
  const request: Promise<AssignableUser[]> = fetchAssignableUsersUncached(apiKey, teamId).catch((e) => {
    if (assignableUsersCache.get(key) === request) assignableUsersCache.delete(key);
    throw e;
  });
  assignableUsersCache.set(key, request);
  return request;
}

export function clearAssignableUsersCache(): void {
  assignableUsersCache.clear();
  assignableUsersCacheToken = null;
}

export async function createIssueRelation(apiKey: string, issueId: string, relatedIssueId: string): Promise<void> {
  await gql(
    apiKey,
    `mutation($issueId: String!, $relatedIssueId: String!) {
      issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: blocks }) {
        success
      }
    }`,
    { issueId, relatedIssueId },
  );
}

export async function removeIssueRelation(apiKey: string, issueId: string, relatedIssueId: string): Promise<void> {
  // First find the relation ID, then delete it
  const data = await gql(
    apiKey,
    `query($id: String!) {
      issue(id: $id) {
        relations {
          nodes {
            id
            type
            relatedIssue { id }
          }
        }
      }
    }`,
    { id: issueId },
  );
  const issue = data.issue as {
    relations: { nodes: Array<{ id: string; type: string; relatedIssue: { id: string } }> };
  };
  const relation = issue.relations.nodes.find((r) => r.type === 'blocks' && r.relatedIssue.id === relatedIssueId);
  if (!relation) return;

  await gql(
    apiKey,
    `mutation($id: String!) {
      issueRelationDelete(id: $id) { success }
    }`,
    { id: relation.id },
  );
}

export async function fetchWorkflowStates(apiKey: string, teamId: string): Promise<WorkflowState[]> {
  const data = await gql(
    apiKey,
    `query($teamId: ID!) {
      workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) {
        nodes {
          id
          name
          type
          position
        }
      }
    }`,
    { teamId },
  );
  const states = (data.workflowStates as { nodes?: WorkflowState[] } | undefined)?.nodes ?? [];
  return [...states].sort((a, b) => a.position - b.position);
}

// ---- Feedback issue creation ----

interface FeedbackLabelNode {
  id: string;
  name: string;
  isGroup?: boolean;
  team?: { id: string } | null;
}

interface FeedbackTeamNode {
  id: string;
  key: string;
  name: string;
  labels?: { nodes: FeedbackLabelNode[] } | null;
}

interface FeedbackProjectNode {
  id: string;
  name: string;
  url?: string | null;
  slugId?: string | null;
  teams?: { nodes: FeedbackTeamNode[] } | null;
}

export interface FeedbackTarget {
  teamId: string;
  teamKey: string;
  teamName: string;
  projectId: string;
  projectName: string;
  projectUrl: string;
  labelIds: Record<FeedbackType, string | undefined>;
}

export interface CreatedLinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export class FeedbackTargetNotFoundError extends Error {
  readonly code = 'FEEDBACK_TARGET_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackTargetNotFoundError';
  }
}

function normalizeUrl(url: string | null | undefined): string {
  return (url || '').trim().replace(/\/+$/, '').toLowerCase();
}

export const FEEDBACK_TARGET_QUERY = `query FeedbackTarget {
  projects(first: 100) {
    nodes {
      id
      name
      url
      slugId
      teams(first: 20) {
        nodes {
          id
          key
          name
        }
      }
    }
  }
  teams(first: 100) {
    nodes {
      id
      key
      name
    }
  }
  issueLabels(
    first: 100
    filter: {
      or: [
        { name: { eqIgnoreCase: "feature" } }
        { name: { eqIgnoreCase: "bug" } }
      ]
    }
  ) {
    nodes {
      id
      name
      isGroup
      team {
        id
      }
    }
  }
}`;

export async function resolveFeedbackTarget(apiKey: string, env?: FeedbackEnv): Promise<FeedbackTarget> {
  const config = getFeedbackConfig(env);
  const data = await gql(apiKey, FEEDBACK_TARGET_QUERY);

  const projects = (data.projects as { nodes?: FeedbackProjectNode[] } | undefined)?.nodes ?? [];
  const allTeams = (data.teams as { nodes?: FeedbackTeamNode[] } | undefined)?.nodes ?? [];
  const issueLabels = (data.issueLabels as { nodes?: FeedbackLabelNode[] } | undefined)?.nodes ?? [];

  const targetUrlNorm = normalizeUrl(config.projectUrl);
  const targetNameNorm = config.projectName.trim().toLowerCase();

  const findByName = (name: string) =>
    projects.find((p) => p.name.trim().toLowerCase() === name) ??
    projects.find((p) => p.name.trim().toLowerCase() === 'ganttsmart');

  let project: FeedbackProjectNode | undefined;
  if (config.hasCustomProjectUrl) {
    project =
      projects.find((p) => p.url && normalizeUrl(p.url) === targetUrlNorm) ??
      (config.projectSlugId ? projects.find((p) => p.slugId === config.projectSlugId) : undefined) ??
      (config.projectSlug
        ? projects.find((p) => normalizeUrl(p.url).endsWith(`/${config.projectSlug!.toLowerCase()}`))
        : undefined) ??
      findByName(targetNameNorm);
  } else {
    project =
      projects.find((p) => p.name.trim().toLowerCase() === 'ganttsmart') ??
      (config.projectSlugId ? projects.find((p) => p.slugId === config.projectSlugId) : undefined) ??
      projects.find((p) => normalizeUrl(p.url) === targetUrlNorm);
  }

  if (!project) {
    throw new FeedbackTargetNotFoundError(
      `Could not find the "${config.projectName}" project in your connected Linear workspace.`,
    );
  }

  const projectTeams: FeedbackTeamNode[] = project.teams?.nodes ?? [];
  const targetTeamKey = config.teamKey.trim().toUpperCase();

  const team =
    projectTeams.find((t) => t.key.trim().toUpperCase() === targetTeamKey) ??
    allTeams.find((t) => t.key.trim().toUpperCase() === targetTeamKey) ??
    project.teams?.nodes?.[0];

  if (!team) {
    throw new FeedbackTargetNotFoundError(`Could not find team "${config.teamKey}" for project "${project.name}".`);
  }

  // Prefer team-scoped labels over workspace-wide labels, excluding label groups
  const fullTeam = allTeams.find((t) => t.id === team.id);
  const teamLabels = [
    ...(team.labels?.nodes ?? []),
    ...(fullTeam?.labels?.nodes ?? []),
    ...issueLabels.filter((l) => l.team?.id === team.id),
    ...issueLabels.filter((l) => !l.team),
  ].filter((l) => !l.isGroup);

  const findLabelId = (name: string): string | undefined =>
    teamLabels.find((l) => l.name.trim().toLowerCase() === name)?.id;

  return {
    teamId: team.id,
    teamKey: team.key,
    teamName: team.name,
    projectId: project.id,
    projectName: project.name,
    projectUrl: project.url || config.projectUrl,
    labelIds: {
      feature: findLabelId('feature'),
      bug: findLabelId('bug'),
    },
  };
}

export async function createFeedbackIssue({
  apiKey,
  type,
  title,
  description,
  env,
}: {
  apiKey: string;
  type: FeedbackType;
  title: string;
  description: string;
  env?: FeedbackEnv;
}): Promise<CreatedLinearIssue> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    throw new Error('Title is required');
  }

  const target = await resolveFeedbackTarget(apiKey, env);
  const labelId = target.labelIds[type];

  const input: {
    teamId: string;
    title: string;
    projectId: string;
    description?: string;
    labelIds?: string[];
  } = {
    teamId: target.teamId,
    title: trimmedTitle,
    projectId: target.projectId,
  };

  const trimmedDesc = description.trim();
  if (trimmedDesc) {
    input.description = trimmedDesc;
  }
  if (labelId) {
    input.labelIds = [labelId];
  }

  const data = await gql(
    apiKey,
    `mutation CreateFeedbackIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
        }
      }
    }`,
    { input },
  );

  const payload = data.issueCreate as
    | {
        success?: boolean;
        issue?: CreatedLinearIssue | null;
      }
    | undefined;

  if (!payload?.success || !payload.issue) {
    throw new Error('Linear did not confirm issue creation.');
  }

  return payload.issue;
}

// ---- Linear project external resource links ----

export const GANTT_LINK_LABEL = 'Open in GanttSmart';

export interface ProjectExternalLink {
  id: string;
  label: string;
  url: string;
  archivedAt: string | null;
}

export interface ProjectLinearMetadata {
  url: string | null;
  externalLinks: ProjectExternalLink[];
}

function normalizeLinkUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

/** Find an active (non-archived) external link pointing to the same URL. */
export function findActiveExternalLink(
  links: ProjectExternalLink[],
  targetUrl: string,
): ProjectExternalLink | undefined {
  const normalizedTarget = normalizeLinkUrl(targetUrl);
  return links.find((link) => link.archivedAt == null && normalizeLinkUrl(link.url) === normalizedTarget);
}

/** Fetch a Linear project's URL and active external resource links. */
export async function fetchProjectExternalLinks(apiKey: string, projectId: string): Promise<ProjectLinearMetadata> {
  const data = await gql(
    apiKey,
    `query ProjectExternalLinks($id: String!) {
      project(id: $id) {
        url
        externalLinks {
          nodes {
            id
            label
            url
            archivedAt
          }
        }
      }
    }`,
    { id: projectId },
  );

  const project = data?.project as {
    url?: string | null;
    externalLinks?: { nodes?: ProjectExternalLink[] } | null;
  } | null;

  const nodes = project?.externalLinks?.nodes ?? [];
  return {
    url: typeof project?.url === 'string' && project.url ? project.url : null,
    externalLinks: nodes.filter((link): link is ProjectExternalLink => Boolean(link) && link.archivedAt == null),
  };
}

/**
 * Create an "Open in GanttSmart" external link on a Linear project pointing to
 * `${origin}/app?project=${projectId}`. Avoids creating a duplicate if an active
 * link with the same URL already exists.
 */
export async function createProjectExternalLink(
  apiKey: string,
  projectId: string,
  origin: string,
  options?: { label?: string; existingLinks?: ProjectExternalLink[]; projectUrl?: string | null },
): Promise<{ link: ProjectExternalLink; created: boolean; projectUrl: string | null }> {
  const label = options?.label ?? GANTT_LINK_LABEL;
  const targetUrl = buildProjectDeepLink(origin, projectId);

  let projectUrl: string | null = options?.projectUrl ?? null;
  let linksToCheck = options?.existingLinks;

  if (!linksToCheck) {
    const meta = await fetchProjectExternalLinks(apiKey, projectId);
    projectUrl = meta.url;
    linksToCheck = meta.externalLinks;
  }

  const existing = findActiveExternalLink(linksToCheck, targetUrl);
  if (existing) {
    return { link: existing, created: false, projectUrl };
  }

  const data = await gql(
    apiKey,
    `mutation($input: EntityExternalLinkCreateInput!) {
      entityExternalLinkCreate(input: $input) {
        success
        entityExternalLink {
          id
          label
          url
        }
      }
    }`,
    {
      input: {
        projectId,
        url: targetUrl,
        label,
      },
    },
  );

  const res = data?.entityExternalLinkCreate as {
    success?: boolean;
    entityExternalLink?: { id: string; label: string; url: string } | null;
  } | null;

  if (!res?.success || !res.entityExternalLink) {
    throw new Error('Could not create external link on Linear project');
  }

  return {
    link: {
      id: res.entityExternalLink.id,
      label: res.entityExternalLink.label,
      url: res.entityExternalLink.url,
      archivedAt: null,
    },
    created: true,
    projectUrl,
  };
}
