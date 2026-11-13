import { backend } from '@/backend';
import { PRIORITY_MAP, type Milestone, type Project, type Task, type WorkflowState } from '@/types';
import { isIgnoredIssueState, type IssueStateLike } from '@/utils/issues';
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
  await gql(
    apiKey,
    `mutation($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) {
        success
      }
    }`,
    { id: issueId, stateId },
  );
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
    `query($teamId: String!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
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
  const states = data.workflowStates as { nodes: WorkflowState[] };
  return states.nodes.sort((a, b) => a.position - b.position);
}
