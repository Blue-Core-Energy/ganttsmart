import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import type { Config } from '../src/config.js';
import { UnauthorizedError, type Identity } from '../src/identity.js';
import type { LinearOAuth } from '../src/linear/oauth.js';
import { createMemoryStore } from '../src/store/memory.js';
import type { Store } from '../src/store/types.js';

const ORIGIN = 'https://gantt.example.com';
const ALICE: Identity = { sub: 'accounts.google.com:alice', email: 'alice@bluecore.energy' };
const BOB: Identity = { sub: 'accounts.google.com:bob', email: 'bob@bluecore.energy' };
const INDEX_HTML = '<!doctype html><title>GanttSmart</title><div id="root"></div>';
const ASSET_JS = 'console.log("asset");';
const SECRET = 'top-secret-outside-static-dir';

const baseConfig: Config = {
  port: 8080,
  isProduction: false,
  appOrigin: ORIGIN,
  allowedDomain: 'bluecore.energy',
  iapAudience: '/projects/1/global/backendServices/2',
  devUserEmail: null,
  linearClientId: 'id',
  linearClientSecret: 'secret',
  linearRedirectUri: `${ORIGIN}/api/linear/callback`,
  staticDir: 'dist',
};

/** `x-test-user: alice|bob` authenticates as that user; anything else is rejected. */
const identify: AppDeps['identify'] = async (req) => {
  const who = req.headers.get('x-test-user');
  if (who === 'alice') return { ...ALICE };
  if (who === 'bob') return { ...BOB };
  throw new UnauthorizedError('Missing IAP assertion');
};

const oauth: LinearOAuth = {
  authorizeUrl: (state) => `https://linear.app/oauth/authorize?state=${state}`,
  exchangeCode: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: null }),
  refresh: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: null }),
  revoke: async () => {},
};

// staticDir is <tmp>/root/dist, with a secret file at <tmp>/root/secret.txt and <tmp>/secret.txt.
let tmp: string;
let staticDir: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ganttsmart-static-'));
  staticDir = join(tmp, 'root', 'dist');
  mkdirSync(join(staticDir, 'assets'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(staticDir, 'favicon.svg'), '<svg/>');
  writeFileSync(join(staticDir, 'assets', 'a.js'), ASSET_JS);
  writeFileSync(join(tmp, 'root', 'secret.txt'), SECRET);
  writeFileSync(join(tmp, 'secret.txt'), SECRET);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorLog.mockRestore();
});

function setup(store: Store = createMemoryStore()) {
  const app = createApp({ config: { ...baseConfig, staticDir }, identify, store, oauth });
  return { app, store };
}

const as = (user: 'alice' | 'bob' = 'alice') => ({ 'x-test-user': user });
const postJson = (body: unknown, user: 'alice' | 'bob' = 'alice'): RequestInit => ({
  method: 'POST',
  headers: { ...as(user), origin: ORIGIN, 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const ISSUE = '6f1c3c1e-2b1a-4c3d-9e8f-0123456789ab';

describe('history: baselines', () => {
  it('round trips, and a second POST with different dates does not change the first', async () => {
    const { app } = setup();
    const first = await app.request(
      '/api/history/baselines',
      postJson({
        projectId: 'proj-1',
        baselines: [
          { issue_id: 'ENG-1', planned_start: '2026-01-01', planned_due: '2026-02-01' },
          { issue_id: 'ENG-2', planned_due: '2026-03-01' },
        ],
      }),
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ ok: true });

    const second = await app.request(
      '/api/history/baselines',
      postJson({
        projectId: 'proj-1',
        baselines: [{ issue_id: 'ENG-1', planned_start: '2027-01-01', planned_due: '2027-02-01' }],
      }),
    );
    expect(second.status).toBe(200);

    const res = await app.request('/api/history/baselines?projectId=proj-1', { headers: as() });
    expect(res.status).toBe(200);
    const { baselines } = (await res.json()) as { baselines: Record<string, unknown>[] };
    const byId = Object.fromEntries(baselines.map((b) => [b.issue_id, b]));
    expect(Object.keys(byId).sort()).toEqual(['ENG-1', 'ENG-2']);
    expect(byId['ENG-1']).toMatchObject({ planned_start: '2026-01-01', planned_due: '2026-02-01' });
    // A missing planned_start is stored as null, never undefined.
    expect(byId['ENG-2']).toMatchObject({ planned_start: null, planned_due: '2026-03-01' });
    expect(typeof byId['ENG-1'].first_seen_at).toBe('string');
  });

  it('returns 400 when projectId is missing', async () => {
    const { app } = setup();
    const res = await app.request('/api/history/baselines', { headers: as() });
    expect(res.status).toBe(400);
  });

  it('scopes baselines to the signed-in user', async () => {
    const { app } = setup();
    await app.request(
      '/api/history/baselines',
      postJson({ projectId: 'p', baselines: [{ issue_id: 'ENG-1', planned_start: null, planned_due: '2026-01-01' }] }),
    );
    const res = await app.request('/api/history/baselines?projectId=p', { headers: as('bob') });
    await expect(res.json()).resolves.toEqual({ baselines: [] });
  });

  it.each([
    ['projectId missing', { baselines: [] }],
    ['projectId not a string', { projectId: 5, baselines: [] }],
    ['projectId with a slash', { projectId: 'a/b', baselines: [] }],
    ['baselines not an array', { projectId: 'p', baselines: {} }],
    ['row not an object', { projectId: 'p', baselines: ['x'] }],
    ['issue_id empty', { projectId: 'p', baselines: [{ issue_id: '', planned_due: '2026-01-01' }] }],
    ['issue_id path-like', { projectId: 'p', baselines: [{ issue_id: '../x', planned_due: '2026-01-01' }] }],
    ['issue_id too long', { projectId: 'p', baselines: [{ issue_id: 'a'.repeat(129), planned_due: 'd' }] }],
    ['planned_due missing', { projectId: 'p', baselines: [{ issue_id: 'ENG-1' }] }],
    ['planned_due empty', { projectId: 'p', baselines: [{ issue_id: 'ENG-1', planned_due: '' }] }],
    [
      'planned_start a number',
      { projectId: 'p', baselines: [{ issue_id: 'ENG-1', planned_start: 1, planned_due: 'd' }] },
    ],
    ['planned_due too long', { projectId: 'p', baselines: [{ issue_id: 'ENG-1', planned_due: 'd'.repeat(1001) }] }],
    [
      'too many rows',
      {
        projectId: 'p',
        baselines: Array.from({ length: 2001 }, (_, i) => ({ issue_id: `E-${i}`, planned_due: 'd' })),
      },
    ],
  ])('POST returns 400 for %s', async (_name, body) => {
    const { app, store } = setup();
    const res = await app.request('/api/history/baselines', postJson(body));
    expect(res.status).toBe(400);
    await expect(store.listBaselines(ALICE.sub, 'p')).resolves.toEqual([]);
  });

  it('accepts exactly 2000 rows', async () => {
    const { app } = setup();
    const baselines = Array.from({ length: 2000 }, (_, i) => ({ issue_id: `E-${i}`, planned_due: 'd' }));
    const res = await app.request('/api/history/baselines', postJson({ projectId: 'p', baselines }));
    expect(res.status).toBe(200);
  });

  it('keeps the first row when a POST repeats an issue', async () => {
    const { app } = setup();
    const res = await app.request(
      '/api/history/baselines',
      postJson({
        projectId: 'p',
        baselines: [
          { issue_id: 'ENG-1', planned_start: null, planned_due: '2026-01-01' },
          { issue_id: 'ENG-1', planned_start: null, planned_due: '2099-01-01' },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const list = await app.request('/api/history/baselines?projectId=p', { headers: as() });
    const { baselines } = (await list.json()) as { baselines: Record<string, unknown>[] };
    expect(baselines).toEqual([expect.objectContaining({ issue_id: 'ENG-1', planned_due: '2026-01-01' })]);
  });

  it('returns 413 for a body over 1 MiB', async () => {
    const { app } = setup();
    const res = await app.request('/api/history/baselines', postJson('x'.repeat(1024 * 1024 + 1)));
    expect(res.status).toBe(413);
  });

  it('returns 400 for a body that is not JSON', async () => {
    const { app } = setup();
    const res = await app.request('/api/history/baselines', postJson('{nope'));
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid projectId query', async () => {
    const { app } = setup();
    const res = await app.request('/api/history/baselines?projectId=a%2Fb', { headers: as() });
    expect(res.status).toBe(400);
  });
});

describe('history: changes', () => {
  it('returns changes newest first, at most 50', async () => {
    const { app } = setup();
    for (let i = 0; i < 51; i++) {
      const res = await app.request(
        '/api/history/changes',
        postJson({ projectId: 'p', issueId: ISSUE, field: 'dueDate', oldValue: `old-${i}`, newValue: `new-${i}` }),
      );
      expect(res.status).toBe(200);
    }
    const res = await app.request(`/api/history/changes?issueId=${ISSUE}`, { headers: as() });
    expect(res.status).toBe(200);
    const { changes } = (await res.json()) as { changes: Record<string, unknown>[] };
    expect(changes).toHaveLength(50);
    expect(changes[0]).toMatchObject({
      issue_id: ISSUE,
      field_changed: 'dueDate',
      old_value: 'old-50',
      new_value: 'new-50',
    });
    expect(changes[49]).toMatchObject({ new_value: 'new-1' });
  });

  it('stores missing oldValue/newValue as null', async () => {
    const { app } = setup();
    const res = await app.request('/api/history/changes', postJson({ projectId: 'p', issueId: 'ENG-9', field: 'f' }));
    expect(res.status).toBe(200);
    const list = await app.request('/api/history/changes?issueId=ENG-9', { headers: as() });
    const { changes } = (await list.json()) as { changes: Record<string, unknown>[] };
    expect(changes).toEqual([expect.objectContaining({ old_value: null, new_value: null })]);
  });

  it('scopes changes to the signed-in user', async () => {
    const { app } = setup();
    await app.request(
      '/api/history/changes',
      postJson({ projectId: 'p', issueId: 'ENG-1', field: 'f', newValue: 'x' }),
    );
    const res = await app.request('/api/history/changes?issueId=ENG-1', { headers: as('bob') });
    await expect(res.json()).resolves.toEqual({ changes: [] });
  });

  it('returns 400 for a body with issueId: 5', async () => {
    const { app, store } = setup();
    const res = await app.request('/api/history/changes', postJson({ projectId: 'p', issueId: 5, field: 'f' }));
    expect(res.status).toBe(400);
    await expect(store.listChanges(ALICE.sub, '5', 50)).resolves.toEqual([]);
  });

  it.each([
    ['projectId missing', { issueId: 'ENG-1', field: 'f' }],
    ['issueId with a slash', { projectId: 'p', issueId: 'ENG/1', field: 'f' }],
    ['field missing', { projectId: 'p', issueId: 'ENG-1' }],
    ['field empty', { projectId: 'p', issueId: 'ENG-1', field: '' }],
    ['oldValue a number', { projectId: 'p', issueId: 'ENG-1', field: 'f', oldValue: 1 }],
    ['newValue an object', { projectId: 'p', issueId: 'ENG-1', field: 'f', newValue: {} }],
    ['newValue too long', { projectId: 'p', issueId: 'ENG-1', field: 'f', newValue: 'x'.repeat(1001) }],
    ['body an array', []],
    ['body null', null],
  ])('POST returns 400 for %s', async (_name, body) => {
    const { app } = setup();
    const res = await app.request('/api/history/changes', postJson(body));
    expect(res.status).toBe(400);
  });

  it.each(['', '?issueId=', '?issueId=..%2Fx'])('GET returns 400 for query %j', async (query) => {
    const { app } = setup();
    const res = await app.request(`/api/history/changes${query}`, { headers: as() });
    expect(res.status).toBe(400);
  });
});

describe('history: transitions', () => {
  it('returns 200 for a valid transition', async () => {
    const { app } = setup();
    const res = await app.request(
      '/api/history/transitions',
      postJson({ projectId: 'p', issueId: 'ENG-1', fromStatus: 'Todo', toStatus: 'In Progress' }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('records a missing fromStatus as null', async () => {
    const store = createMemoryStore();
    const added = vi.spyOn(store, 'addTransition');
    const { app } = setup(store);
    const res = await app.request(
      '/api/history/transitions',
      postJson({ projectId: 'p', issueId: 'ENG-1', toStatus: 'Done' }),
    );
    expect(res.status).toBe(200);
    expect(added).toHaveBeenCalledWith(ALICE.sub, {
      projectId: 'p',
      issueId: 'ENG-1',
      fromStatus: null,
      toStatus: 'Done',
    });
  });

  it.each([
    ['toStatus missing', { projectId: 'p', issueId: 'ENG-1' }],
    ['toStatus null', { projectId: 'p', issueId: 'ENG-1', toStatus: null }],
    ['fromStatus a boolean', { projectId: 'p', issueId: 'ENG-1', fromStatus: true, toStatus: 'Done' }],
    ['issueId a number', { projectId: 'p', issueId: 5, toStatus: 'Done' }],
  ])('POST returns 400 for %s', async (_name, body) => {
    const { app } = setup();
    const res = await app.request('/api/history/transitions', postJson(body));
    expect(res.status).toBe(400);
  });
});

describe('history: middleware', () => {
  it('requires an identity', async () => {
    const { app } = setup();
    const res = await app.request('/api/history/baselines?projectId=p');
    expect(res.status).toBe(401);
  });

  it('rejects a POST from another origin', async () => {
    const { app } = setup();
    const res = await app.request('/api/history/transitions', {
      method: 'POST',
      headers: { ...as(), origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', issueId: 'ENG-1', toStatus: 'Done' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('static hosting', () => {
  it('serves /assets/* with an immutable cache header', async () => {
    const { app } = setup();
    const res = await app.request('/assets/a.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await expect(res.text()).resolves.toBe(ASSET_JS);
  });

  it('serves index.html for an app route, with no-cache', async () => {
    const { app } = setup();
    const res = await app.request('/app');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    await expect(res.text()).resolves.toBe(INDEX_HTML);
  });

  it.each(['/', '/index.html', '/app/projects/123'])('serves index.html for %s with no-cache', async (path) => {
    const { app } = setup();
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    await expect(res.text()).resolves.toBe(INDEX_HTML);
  });

  it('serves other top-level files with no-cache', async () => {
    const { app } = setup();
    const res = await app.request('/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    await expect(res.text()).resolves.toBe('<svg/>');
  });

  it('returns 404 (not index.html) for a missing asset', async () => {
    const { app } = setup();
    const res = await app.request('/assets/missing.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).not.toBe('public, max-age=31536000, immutable');
  });

  it('does not need an identity for static files', async () => {
    const { app } = setup();
    const res = await app.request('/app');
    expect(res.status).toBe(200);
  });

  it('returns 404 JSON for an unknown /api route', async () => {
    const { app } = setup();
    const res = await app.request('/api/nope', { headers: as() });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    await expect(res.json()).resolves.toEqual({ error: 'not found' });
  });

  it('never serves index.html for an unknown /api route', async () => {
    const { app } = setup();
    for (const path of ['/api', '/api/', '/api/history', '/api/nope/deeper']) {
      const res = await app.request(path, { headers: as() });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('GanttSmart');
    }
  });

  it.each([
    '/../secret.txt',
    '/../../secret.txt',
    '/assets/../../secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/..%5csecret.txt',
    '/assets/..%5c..%5csecret.txt',
    '/%252e%252e/secret.txt',
  ])('cannot escape staticDir via %s', async (path) => {
    const { app } = setup();
    // Build the Request by hand so the path reaches the app exactly as a client could send it.
    const res = await app.fetch(new Request(`http://localhost${path}`));
    expect(await res.text()).not.toContain(SECRET);
  });
});
