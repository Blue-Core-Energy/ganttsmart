import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../app.js';
import type { BaselineRow, ChangeInput, Store, TransitionInput } from '../store/types.js';

const CHANGES_LIMIT = 50;
const MAX_BASELINE_ROWS = 2000;
const MAX_STRING_LENGTH = 1000;
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Ids become Firestore document ids or path segments, so allow only what Linear uses
 * (UUIDs and identifiers like ENG-123): no slashes, dots or other separators.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Thrown by the validators below; turned into a 400 by the route. */
class InvalidInput extends Error {}

type Fields = Record<string, unknown>;

function object(value: unknown, what: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidInput(`${what} must be an object`);
  }
  return value as Fields;
}

function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new InvalidInput(`${name} is invalid`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_STRING_LENGTH) {
    throw new InvalidInput(`${name} must be a non-empty string of at most ${MAX_STRING_LENGTH} characters`);
  }
  return value;
}

/** String or null; missing becomes null, because Firestore rejects undefined fields. */
function nullableString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) {
    throw new InvalidInput(`${name} must be a string or null`);
  }
  return value;
}

function parseBaselines(body: unknown): { projectId: string; rows: BaselineRow[] } {
  const b = object(body, 'body');
  const projectId = id(b.projectId, 'projectId');
  if (!Array.isArray(b.baselines)) throw new InvalidInput('baselines must be an array');
  if (b.baselines.length > MAX_BASELINE_ROWS) throw new InvalidInput(`at most ${MAX_BASELINE_ROWS} baselines`);
  const rows = b.baselines.map((raw): BaselineRow => {
    const r = object(raw, 'baseline');
    return {
      issue_id: id(r.issue_id, 'issue_id'),
      planned_start: nullableString(r.planned_start, 'planned_start'),
      planned_due: requiredString(r.planned_due, 'planned_due'),
    };
  });
  // The first row for an issue wins, as it would across requests; Firestore would otherwise race.
  const seen = new Set<string>();
  return { projectId, rows: rows.filter((r) => !seen.has(r.issue_id) && seen.add(r.issue_id)) };
}

function parseChange(body: unknown): ChangeInput {
  const b = object(body, 'body');
  return {
    projectId: id(b.projectId, 'projectId'),
    issueId: id(b.issueId, 'issueId'),
    field: requiredString(b.field, 'field'),
    oldValue: nullableString(b.oldValue, 'oldValue'),
    newValue: nullableString(b.newValue, 'newValue'),
  };
}

function parseTransition(body: unknown): TransitionInput {
  const b = object(body, 'body');
  return {
    projectId: id(b.projectId, 'projectId'),
    issueId: id(b.issueId, 'issueId'),
    fromStatus: nullableString(b.fromStatus, 'fromStatus'),
    toStatus: requiredString(b.toStatus, 'toStatus'),
  };
}

/** Planning history for the signed-in user. The user is always `identity.sub`, never the request. */
export function historyRoutes(deps: { store: Store }): Hono<AppEnv> {
  const { store } = deps;
  const routes = new Hono<AppEnv>();

  routes.onError((err, c) => {
    if (err instanceof InvalidInput) return c.json({ error: err.message }, 400);
    console.error('History request failed', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
    return c.json({ error: 'internal error' }, 500);
  });

  routes.use(
    '*',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'request body too large' }, 413) }),
  );

  /** The JSON body, or InvalidInput if it is not JSON. */
  const jsonBody = async (req: Request): Promise<unknown> => {
    try {
      return JSON.parse(await req.text());
    } catch {
      throw new InvalidInput('expected a JSON body');
    }
  };

  routes.get('/baselines', async (c) => {
    const projectId = id(c.req.query('projectId'), 'projectId');
    const baselines = await store.listBaselines(c.get('identity').sub, projectId);
    return c.json({ baselines });
  });

  routes.post('/baselines', async (c) => {
    const { projectId, rows } = parseBaselines(await jsonBody(c.req.raw));
    await store.addBaselinesIfAbsent(c.get('identity').sub, projectId, rows);
    return c.json({ ok: true });
  });

  routes.get('/changes', async (c) => {
    const issueId = id(c.req.query('issueId'), 'issueId');
    const changes = await store.listChanges(c.get('identity').sub, issueId, CHANGES_LIMIT);
    return c.json({ changes });
  });

  routes.post('/changes', async (c) => {
    const change = parseChange(await jsonBody(c.req.raw));
    await store.addChange(c.get('identity').sub, change);
    return c.json({ ok: true });
  });

  routes.post('/transitions', async (c) => {
    const transition = parseTransition(await jsonBody(c.req.raw));
    await store.addTransition(c.get('identity').sub, transition);
    return c.json({ ok: true });
  });

  return routes;
}
