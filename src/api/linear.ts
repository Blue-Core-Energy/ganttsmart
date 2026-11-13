import { backend } from '@/backend';
import { PRIORITY_MAP, type Milestone, type Project, type Task, type WorkflowState } from '@/types';
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

// ---- Core GraphQL with retry + rate limit awareness ----
async function gql(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
  retries = 2,
): Promise<Record<string, unknown>> {
  await waitForSlot();
  try {
    const res = await backend.linearRequest(apiKey, { query, variables });

    // Rate limited — retry after delay
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
      if (retries > 0) {
        releaseSlot();
        await delay(retryAfter * 1000);
        return gql(apiKey, query, variables, retries - 1);
      }
      throw new Error('Rate limited by Linear API. Please wait a moment and try again.');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) throw new Error('Linear authentication expired. Please reconnect.');
      if (res.status >= 500 && retries > 0) {
        releaseSlot();
        await delay(1000);
        return gql(apiKey, query, variables, retries - 1);
      }
      throw new Error(`Linear API error (${res.status}): ${text || res.statusText}`);
    }

    const data = await res.json();
    if (data.errors) {
      const msg = data.errors[0]?.message || 'Unknown GraphQL error';
      // Retry on transient errors
      if (retries > 0 && (msg.includes('timeout') || msg.includes('unavailable'))) {
        releaseSlot();
        await delay(1000);
        return gql(apiKey, query, variables, retries - 1);
      }
      throw new Error(msg);
    }
    return data.data as Record<string, unknown>;
  } catch (e) {
    // Network errors — retry once
    if (retries > 0 && (e as Error).message?.includes('fetch')) {
      releaseSlot();
      await delay(1000);
      return gql(apiKey, query, variables, retries - 1);
    }
    throw e;
  } finally {
    releaseSlot();
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

/** Parse `start: DD-MM-YY` from issue description */
function parseStartDate(description: string): string | null {
  const match = description.match(/start:\s*(\d{2})-(\d{2})-(\d{2})/i);
  if (!match) return null;
  const [, dd, mm, yy] = match;
  const year = 2000 + parseInt(yy);
  const month = parseInt(mm);
  const day = parseInt(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export async function fetchIssues(
  apiKey: string,
  projectId: string,
): Promise<{
  projectName: string;
  tasks: Task[];
  unscheduledTasks: Task[];
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
            assignee { name }
            team { id }
            projectMilestone { id }
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
            assignee { name }
            team { id }
            projectMilestone { id }
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
    assignee: { name: string } | null;
    team: { id: string } | null;
    projectMilestone: { id: string } | null;
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
    if (n.dueDate) return { date: n.dueDate, isImplicit: false };
    if (projectTargetDate) return { date: projectTargetDate, isImplicit: true };
    return null;
  }

  // Query 2: fetch relations and children for all scheduled/unscheduled issues (active + completed).
  // We want relation/child counts on every issue so dependencies and progress work across all tasks.
  const issueIds = [...new Set([...issueNodes, ...doneIssueNodes].map((n) => n.id))];

  const relationsMap: Record<string, { blocks: string[]; blockedBy: string[] }> = {};
  const childrenMap: Record<string, { total: number; completed: number }> = {};

  if (issueIds.length > 0) {
    try {
      interface RelNode {
        type: string;
        relatedIssue: {
          identifier: string;
          canceledAt?: string | null;
          state?: IssueStateLike | null;
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
                      identifier
                      canceledAt
                      state { name type }
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
      }
    } catch {
      console.warn('Failed to fetch relations/children — continuing without them');
    }
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
      startDate: parseStartDate(n.description || ''),
      url: n.url,
      priorityVal: n.priority,
      priority: PRIORITY_MAP[n.priority] || 'None',
      status: n.state?.name || '',
      statusType: n.state?.type || '',
      assignee: n.assignee?.name || 'Unassigned',
      teamId: n.team?.id || '',
      blocks: rel.blocks,
      blockedBy: rel.blockedBy,
      progress,
      totalChildren: ch.total,
      completedChildren: ch.completed,
      completedAt: n.completedAt || undefined,
      isDueImplicit: isDueImplicit || undefined,
      milestoneId: n.projectMilestone?.id ?? null,
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

  return { projectName: project.name, tasks: sortedTasks, unscheduledTasks, milestones };
}

// ---- Mutations (with debouncing for drag operations) ----

export async function updateIssueDueDate(apiKey: string, issueId: string, dueDate: string): Promise<void> {
  await debouncedApiCall(`due-${issueId}`, () =>
    gql(
      apiKey,
      `mutation($id: String!, $dueDate: TimelessDate!) {
        issueUpdate(id: $id, input: { dueDate: $dueDate }) {
          success
        }
      }`,
      { id: issueId, dueDate },
    ),
  );
}

export async function updateIssueStartDate(apiKey: string, issueId: string, startDate: string): Promise<void> {
  await debouncedApiCall(`start-${issueId}`, async () => {
    // Fetch current description
    const data = await gql(apiKey, `query($id: String!) { issue(id: $id) { description } }`, { id: issueId });
    const issue = data.issue as { description: string | null };
    const currentDesc: string = issue?.description || '';

    // Format the new start tag: start: DD-MM-YY
    const d = new Date(startDate + 'T00:00:00');
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    const newTag = `start: ${dd}-${mm}-${yy}`;

    let newDesc: string;
    if (/start:\s*\d{2}-\d{2}-\d{2}/i.test(currentDesc)) {
      newDesc = currentDesc.replace(/start:\s*\d{2}-\d{2}-\d{2}/i, newTag);
    } else {
      newDesc = currentDesc.trim() ? `${currentDesc.trim()}\n${newTag}` : newTag;
    }

    await gql(
      apiKey,
      `mutation($id: String!, $description: String!) {
        issueUpdate(id: $id, input: { description: $description }) {
          success
        }
      }`,
      { id: issueId, description: newDesc },
    );
  });
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

const FEEDBACK_TARGET_QUERY = `query FeedbackTarget {
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
          labels(first: 100) {
            nodes {
              id
              name
              isGroup
            }
          }
        }
      }
    }
  }
  teams(first: 100) {
    nodes {
      id
      key
      name
      labels(first: 100) {
        nodes {
          id
          name
          isGroup
        }
      }
    }
  }
  issueLabels(first: 100) {
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

  // Merge labels from the top-level team list if the project-nested team omitted them, excluding label groups
  const fullTeam = allTeams.find((t) => t.id === team.id);
  const teamLabels = [
    ...(team.labels?.nodes ?? []),
    ...(fullTeam?.labels?.nodes ?? []),
    ...issueLabels.filter((l) => !l.team || l.team.id === team.id),
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
