import 'jsr:@supabase/functions-js@2.118.0/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { handleCorsPreflight, jsonResponse } from '../_shared/cors.ts';
import { getValidLinearToken } from '../_shared/linear-token.ts';
import {
  computeClientIpHash,
  extractClientIp,
  hashPasswordPBKDF2,
  MAX_AGGREGATE_ATTEMPTS,
  MAX_PASSWORD_ATTEMPTS,
  parseStartDate,
  RATE_LIMIT_WINDOW_MS,
  sanitizeCachedRoadmapData,
  STALE_TTL_MS,
  validateExpiresInDays,
  validatePassword,
  verifyPassword,
} from '../_shared/share-utils.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const LINEAR_API = 'https://api.linear.app/graphql';
const PRIORITY_MAP: Record<number, string> = { 0: 'None', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

// --- Rate limiting (AUTH-VULN-03 & IT-153 fix) ---

async function getClientIpHash(req: Request): Promise<string> {
  const rawIp = extractClientIp(req.headers);
  return computeClientIpHash(rawIp);
}

// --- GraphQL with variables (INJ-VULN-01 fix) ---

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  priority: number;
  completedAt: string | null;
  canceledAt?: string | null;
  state: { name: string; type: string } | null;
  assignee: { name: string } | null;
  parent?: { identifier: string } | null;
}

function isIgnoredIssueState(
  state?: { name?: string | null; type?: string | null } | null,
  canceledAt?: string | null,
): boolean {
  if (canceledAt) return true;
  const type = state?.type?.trim().toLowerCase();
  if (type === 'canceled' || type === 'cancelled' || type === 'duplicate') return true;
  const name = state?.name?.trim().toLowerCase();
  if (name === 'duplicate' || name === 'canceled' || name === 'cancelled') return true;
  return false;
}

interface MappedTask {
  id: string;
  uuid: string;
  title: string;
  description: string;
  due: string;
  startDate: string | null;
  priorityVal: number;
  priority: string;
  status: string;
  statusType: string;
  assignee: string;
  url: string;
  teamId: string;
  blocks: string[];
  blockedBy: string[];
  progress: number;
  totalChildren: number;
  completedChildren: number;
  completedAt: string | undefined;
  isDueImplicit: boolean | undefined;
  parentId: string | null;
}

interface CachedRoadmapData {
  tasks: MappedTask[];
  doneTasks: MappedTask[];
  unscheduledTasks: MappedTask[];
  milestones: unknown[];
  projectName: string;
  customOrder?: string[];
}

interface SharedRoadmapListRow {
  id: string;
  share_token: string;
  project_id: string;
  project_name: string;
  expires_at: string;
  cached_at: string | null;
  password_hash: string | null;
  created_at: string;
}

async function fetchLinearData(apiKey: string, projectId: string): Promise<CachedRoadmapData> {
  const query = `query($id: String!) {
    project(id: $id) {
      name
      targetDate
      issues(first: 250, filter: { completedAt: { null: true }, canceledAt: { null: true } }) {
        nodes {
          id identifier title description dueDate priority completedAt canceledAt
          state { name type }
          assignee { name }
          parent { identifier }
        }
      }
      doneIssues: issues(first: 100, filter: { completedAt: { null: false }, canceledAt: { null: true } }) {
        nodes {
          id identifier title description dueDate priority completedAt canceledAt
          state { name type }
          assignee { name }
          parent { identifier }
        }
      }
    }
  }`;

  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables: { id: projectId } }),
  });

  if (!res.ok) throw new Error(`Linear API returned ${res.status}`);
  const result = await res.json();
  if (result.errors) throw new Error(result.errors[0].message);

  const project = result.data?.project;
  if (!project) throw new Error('Project not found');

  // Effective due: explicit dueDate, falling back to project target date (parity with main app).
  const projectTargetDate: string | null = project.targetDate || null;
  function effectiveDue(n: LinearIssueNode): { date: string; isImplicit: boolean } | null {
    if (n.dueDate) return { date: n.dueDate, isImplicit: false };
    if (projectTargetDate) return { date: projectTargetDate, isImplicit: true };
    return null;
  }

  function mapNode(n: LinearIssueNode, due: string, isDueImplicit: boolean): MappedTask {
    return {
      id: n.identifier,
      uuid: n.id,
      title: n.title,
      description: '',
      due,
      startDate: parseStartDate(n.description),
      priorityVal: n.priority,
      priority: PRIORITY_MAP[n.priority] || 'None',
      status: n.state?.name || '',
      statusType: n.state?.type || '',
      assignee: n.assignee?.name || 'Unassigned',
      url: '',
      teamId: '',
      blocks: [],
      blockedBy: [],
      progress: 0,
      totalChildren: 0,
      completedChildren: 0,
      completedAt: n.completedAt || undefined,
      isDueImplicit: isDueImplicit || undefined,
      parentId: n.parent?.identifier ?? null,
    };
  }

  // Unify active scheduled issues and completed scheduled issues into a single tasks list.
  const tasks: MappedTask[] = [];
  const unscheduledTasks: MappedTask[] = [];
  const seenIds = new Set<string>();
  for (const n of project.issues.nodes as LinearIssueNode[]) {
    if (isIgnoredIssueState(n.state, n.canceledAt)) continue;
    seenIds.add(n.id);
    const eff = effectiveDue(n);
    if (eff) {
      tasks.push(mapNode(n, eff.date, eff.isImplicit));
    } else {
      // Placeholder due so consumers that need `due` can render. Marked implicit.
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      unscheduledTasks.push(mapNode(n, todayStr, true));
    }
  }
  for (const n of (project.doneIssues?.nodes || []) as LinearIssueNode[]) {
    if (isIgnoredIssueState(n.state, n.canceledAt) || seenIds.has(n.id)) continue;
    const eff = effectiveDue(n);
    if (eff) {
      seenIds.add(n.id);
      tasks.push(mapNode(n, eff.date, eff.isImplicit));
    }
  }
  tasks.sort(
    (a, b) =>
      a.priorityVal - b.priorityVal ||
      new Date(a.due).getTime() - new Date(b.due).getTime() ||
      a.id.localeCompare(b.id),
  );
  unscheduledTasks.sort((a, b) => a.priorityVal - b.priorityVal || a.id.localeCompare(b.id));

  return { tasks, doneTasks: [], unscheduledTasks, milestones: [], projectName: project.name };
}

// --- Custom display order (mirrors the sort in src/hooks/useLinearData.ts) ---

function sanitizeCustomOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').slice(0, 1000);
}

// Re-sort scheduled tasks by the owner's saved order (task uuids). Tasks not in the
// order (new issues) keep their default priority/due order after the ordered ones.
// The order is embedded in cached_data so every refresh path can re-apply it.
function withCustomOrder(data: CachedRoadmapData, customOrder: string[]): CachedRoadmapData {
  if (customOrder.length === 0) return data;
  const pos = new Map(customOrder.map((uuid, i) => [uuid, i]));
  const tasks = [...data.tasks].sort((a, b) => {
    const ai = pos.get(a.uuid);
    const bi = pos.get(b.uuid);
    if (ai === undefined && bi === undefined) return 0;
    if (ai === undefined) return 1;
    if (bi === undefined) return -1;
    return ai - bi;
  });
  return { ...data, tasks, customOrder };
}

async function getUser(req: Request) {
  const h = req.headers.get('Authorization');
  if (!h) return null;
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const {
    data: { user },
  } = await sb.auth.getUser(h.replace('Bearer ', ''));
  return user;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const json = (data: unknown, status = 200) => jsonResponse(data, status, req);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const body = await req.json();
    const action = body.action;

    if (action === 'create') {
      const user = await getUser(req);
      if (!user) return json({ error: 'Unauthorized' }, 401);

      const projectId = body.projectId;
      if (!projectId || typeof projectId !== 'string') return json({ error: 'projectId required' }, 400);

      const expValidation = validateExpiresInDays(body.expiresInDays);
      if (!expValidation.valid) {
        return json({ error: expValidation.error }, 400);
      }
      const days = expValidation.value!;
      const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

      if (body.password !== undefined && body.password !== null && body.password !== '') {
        const pwValidation = validatePassword(body.password);
        if (!pwValidation.valid) {
          return json({ error: pwValidation.error }, 400);
        }
      }

      const linearToken = await getValidLinearToken(supabase, user.id);
      if (!linearToken) return json({ error: 'No Linear token. Connect Linear first.' }, 400);

      let cachedData;
      try {
        cachedData = await fetchLinearData(linearToken, projectId);
      } catch (e) {
        console.error('Failed to fetch Linear data:', e);
        return json({ error: 'Failed to fetch roadmap data' }, 500);
      }
      cachedData = sanitizeCachedRoadmapData(withCustomOrder(cachedData, sanitizeCustomOrder(body.customOrder)));

      const shareToken = crypto.randomUUID();
      const passwordHash = body.password ? await hashPasswordPBKDF2(body.password) : null;

      const { data: share, error: err } = await supabase
        .from('shared_roadmaps')
        .insert({
          owner_id: user.id,
          project_id: projectId,
          project_name: cachedData.projectName,
          share_token: shareToken,
          password_hash: passwordHash,
          expires_at: expiresAt,
          cached_data: cachedData,
          cached_at: new Date().toISOString(),
        })
        .select('id, share_token, project_name, expires_at, cached_at, password_hash')
        .single();

      if (err) {
        console.error('DB insert failed in share-roadmap create:', err);
        return json({ error: 'Failed to create share link' }, 500);
      }

      return json({
        id: share.id,
        shareToken: share.share_token,
        projectName: share.project_name,
        expiresAt: share.expires_at,
        cachedAt: share.cached_at,
        hasPassword: !!share.password_hash,
      });
    }

    if (action === 'get') {
      const { shareToken, password } = body;
      if (!shareToken || typeof shareToken !== 'string') return json({ error: 'shareToken required' }, 400);

      const { data: share, error: shareErr } = await supabase
        .from('shared_roadmaps')
        .select('*')
        .eq('share_token', shareToken)
        .single();

      if (shareErr) {
        if (shareErr.code === 'PGRST116') {
          return json({ error: 'Share not found' }, 404);
        }
        console.error('Database error in share-roadmap get:', shareErr);
        return json({ error: 'Failed to load share' }, 500);
      }
      if (!share) return json({ error: 'Share not found' }, 404);
      if (new Date(share.expires_at) < new Date())
        return json({ error: 'This shared link has expired', expired: true }, 410);

      if (share.password_hash) {
        const clientIpHash = await getClientIpHash(req);

        // Pre-auth prompt: password omitted or empty string
        if (password === undefined || password === null || password === '') {
          // Read-only rate-limit check without burning an attempt slot
          const { data: checkData, error: checkErr } = await supabase.rpc('check_share_rate_limit', {
            p_share_token: shareToken,
            p_client_ip_hash: clientIpHash,
            p_max_attempts: MAX_PASSWORD_ATTEMPTS,
            p_window_seconds: Math.floor(RATE_LIMIT_WINDOW_MS / 1000),
            p_max_aggregate_attempts: MAX_AGGREGATE_ATTEMPTS,
          });

          if (checkErr || !checkData) {
            console.error('check_share_rate_limit DB error:', checkErr?.message);
            return json({ error: 'Service temporarily unavailable' }, 503);
          }

          const checkRow = Array.isArray(checkData) ? checkData[0] : checkData;
          if (!checkRow || typeof checkRow.blocked !== 'boolean') {
            return json({ error: 'Service temporarily unavailable' }, 503);
          }

          if (checkRow.blocked) {
            return json(
              { error: 'Too many attempts. Try again later.', retryAfterSeconds: checkRow.retry_after_seconds },
              429,
            );
          }

          // Pre-auth prompt: omit projectName to prevent information disclosure
          return json({ requiresPassword: true, needsPassword: true });
        }

        // Validate password format
        const pwValidation = validatePassword(password);
        if (!pwValidation.valid) {
          return json({ error: pwValidation.error }, 400);
        }

        // Atomically reserve attempt slot BEFORE running 100k PBKDF2 verifyPassword
        const { data: reserveData, error: reserveErr } = await supabase.rpc('reserve_share_attempt', {
          p_share_token: shareToken,
          p_client_ip_hash: clientIpHash,
          p_max_attempts: MAX_PASSWORD_ATTEMPTS,
          p_window_seconds: Math.floor(RATE_LIMIT_WINDOW_MS / 1000),
          p_max_aggregate_attempts: MAX_AGGREGATE_ATTEMPTS,
        });

        if (reserveErr || !reserveData) {
          console.error('reserve_share_attempt DB error:', reserveErr?.message);
          return json({ error: 'Service temporarily unavailable' }, 503);
        }

        const reserveRow = Array.isArray(reserveData) ? reserveData[0] : reserveData;
        if (!reserveRow || typeof reserveRow.blocked !== 'boolean') {
          return json({ error: 'Service temporarily unavailable' }, 503);
        }

        if (reserveRow.blocked) {
          return json(
            { error: 'Too many attempts. Try again later.', retryAfterSeconds: reserveRow.retry_after_seconds },
            429,
          );
        }

        // Attempt slot reserved: run verification
        const valid = await verifyPassword(password, share.password_hash);
        if (!valid) {
          return json({ error: 'Incorrect password', requiresPassword: true, needsPassword: true }, 403);
        }

        // Reset failed attempts on successful verification
        await supabase.rpc('reset_share_failed_attempts', {
          p_share_token: shareToken,
          p_client_ip_hash: clientIpHash,
        });
      }

      // Auto-refresh: prevent cache stampede with atomic lease
      let cachedData = share.cached_data;
      let cachedAt = share.cached_at;
      const isStale = !cachedAt || Date.now() - new Date(cachedAt).getTime() > STALE_TTL_MS;

      if (isStale) {
        const { data: claimed, error: claimErr } = await supabase.rpc('claim_share_refresh', {
          p_share_id: share.id,
          p_lease_seconds: 30,
          p_stale_age_seconds: Math.floor(STALE_TTL_MS / 1000),
        });

        if (claimErr) {
          console.warn('Failed to claim share refresh lease:', claimErr.message);
        } else if (claimed) {
          try {
            const linearToken = await getValidLinearToken(supabase, share.owner_id);
            if (linearToken) {
              let fresh = await fetchLinearData(linearToken, share.project_id);
              fresh = sanitizeCachedRoadmapData(
                withCustomOrder(fresh, sanitizeCustomOrder(share.cached_data?.customOrder)),
              );
              const newCachedAt = new Date().toISOString();
              const { error: updateErr } = await supabase
                .from('shared_roadmaps')
                .update({ cached_data: fresh, cached_at: newCachedAt, refreshing_until: null })
                .eq('id', share.id);
              if (updateErr) {
                console.error('Failed to update cached_data:', updateErr.message);
              } else {
                cachedData = fresh;
                cachedAt = newCachedAt;
              }
            }
            // If linearToken is missing, let the 30s lease expire naturally as a backoff
          } catch (e) {
            console.warn('share-roadmap auto-refresh failed for', share.id, (e as Error).message);
            // Let the 30s lease expire naturally as a backoff, never failing the cached response
          }
        }
      }

      return json({
        projectName: share.project_name,
        cachedData: sanitizeCachedRoadmapData(cachedData),
        cachedAt,
        expiresAt: share.expires_at,
      });
    }

    if (action === 'list') {
      const user = await getUser(req);
      if (!user) return json({ error: 'Unauthorized' }, 401);

      let q = supabase
        .from('shared_roadmaps')
        .select('id, share_token, project_id, project_name, expires_at, cached_at, password_hash, created_at')
        .eq('owner_id', user.id)
        .order('created_at', { ascending: false });
      if (body.projectId) {
        if (typeof body.projectId !== 'string') return json({ error: 'projectId must be a string' }, 400);
        q = q.eq('project_id', body.projectId);
      }

      const { data, error: err } = await q;
      if (err) {
        console.error('Database error in share-roadmap list:', err);
        return json({ error: 'Failed to list shares' }, 500);
      }

      return json({
        shares: ((data || []) as SharedRoadmapListRow[]).map((s) => ({
          id: s.id,
          shareToken: s.share_token,
          projectId: s.project_id,
          projectName: s.project_name,
          expiresAt: s.expires_at,
          cachedAt: s.cached_at,
          hasPassword: !!s.password_hash,
          createdAt: s.created_at,
        })),
      });
    }

    if (action === 'refresh') {
      const user = await getUser(req);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const { shareId } = body;
      if (!shareId || typeof shareId !== 'string') return json({ error: 'shareId required' }, 400);

      const { data: share, error: fetchErr } = await supabase
        .from('shared_roadmaps')
        .select('project_id, cached_data')
        .eq('id', shareId)
        .eq('owner_id', user.id)
        .single();

      if (fetchErr) {
        if (fetchErr.code === 'PGRST116') {
          return json({ error: 'Share not found' }, 404);
        }
        console.error('Database error in share-roadmap refresh fetch:', fetchErr);
        return json({ error: 'Failed to refresh share' }, 500);
      }
      if (!share) return json({ error: 'Share not found' }, 404);

      const linearToken = await getValidLinearToken(supabase, user.id);
      if (!linearToken) return json({ error: 'No Linear token' }, 400);

      const customOrder =
        body.customOrder !== undefined
          ? sanitizeCustomOrder(body.customOrder)
          : sanitizeCustomOrder(share.cached_data?.customOrder);

      let cachedData;
      try {
        cachedData = await fetchLinearData(linearToken, share.project_id);
      } catch (e) {
        console.error('Failed to fetch Linear data in refresh:', e);
        return json({ error: 'Failed to fetch roadmap data' }, 500);
      }
      cachedData = sanitizeCachedRoadmapData(withCustomOrder(cachedData, customOrder));
      const newCachedAt = new Date().toISOString();
      const { error: updateErr } = await supabase
        .from('shared_roadmaps')
        .update({ cached_data: cachedData, cached_at: newCachedAt, refreshing_until: null })
        .eq('id', shareId)
        .eq('owner_id', user.id);
      if (updateErr) {
        console.error('Database error in share-roadmap refresh update:', updateErr);
        return json({ error: 'Failed to refresh share' }, 500);
      }

      return json({ success: true, cachedAt: newCachedAt });
    }

    if (action === 'delete') {
      const user = await getUser(req);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      const { shareId } = body;
      if (!shareId || typeof shareId !== 'string') return json({ error: 'shareId required' }, 400);

      const { error: deleteErr } = await supabase
        .from('shared_roadmaps')
        .delete()
        .eq('id', shareId)
        .eq('owner_id', user.id);

      if (deleteErr) {
        console.error('Database error in share-roadmap delete:', deleteErr);
        return json({ error: 'Failed to delete share' }, 500);
      }
      return json({ success: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error('Unhandled share-roadmap error:', e);
    return json({ error: 'Internal server error' }, 500);
  }
});
