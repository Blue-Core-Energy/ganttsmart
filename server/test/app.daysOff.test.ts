import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import type { Config } from '../src/config.js';
import { UnauthorizedError } from '../src/identity.js';
import type { LinearOAuth } from '../src/linear/oauth.js';
import { createMemoryStore } from '../src/store/memory.js';
import type { DayOff, Store } from '../src/store/types.js';

const ORIGIN = 'https://gantt.example.com';

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

const identify: AppDeps['identify'] = async (req) => {
  const who = req.headers.get('x-test-user');
  if (who === 'alice') return { sub: 'accounts.google.com:alice', email: 'alice@bluecore.energy' };
  if (who === 'bob') return { sub: 'accounts.google.com:bob', email: 'bob@bluecore.energy' };
  throw new UnauthorizedError('Missing IAP assertion');
};

const oauth: LinearOAuth = {
  authorizeUrl: (state) => `https://linear.app/oauth/authorize?state=${state}`,
  exchangeCode: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: null }),
  refresh: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: null }),
  revoke: async () => {},
};

let tmp: string;
let staticDir: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ganttsmart-nwd-'));
  staticDir = join(tmp, 'dist');
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html>');
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

let stdoutSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  stdoutSpy.mockRestore();
});

function setup(store: Store = createMemoryStore()) {
  const app = createApp({ config: { ...baseConfig, staticDir }, identify, store, oauth });
  return { app, store };
}

type User = 'alice' | 'bob';
const as = (user: User = 'alice') => ({ 'x-test-user': user });
const send = (method: string, body?: unknown, user: User = 'alice'): RequestInit => ({
  method,
  headers: { ...as(user), origin: ORIGIN, 'content-type': 'application/json' },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});

const THANKSGIVING = { label: 'Thanksgiving', startDate: '2026-11-26' };

async function list(app: ReturnType<typeof setup>['app'], user: User = 'alice'): Promise<DayOff[]> {
  const res = await app.request('/api/days-off', { headers: as(user) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { daysOff: DayOff[] }).daysOff;
}

describe('days off: create and list', () => {
  it('starts empty', async () => {
    const { app } = setup();
    expect(await list(app)).toEqual([]);
  });

  it('creates a single company-wide day (endDate defaults to startDate) and lists it', async () => {
    const { app } = setup();
    const res = await app.request('/api/days-off', send('POST', THANKSGIVING));
    expect(res.status).toBe(201);
    const { dayOff } = (await res.json()) as { dayOff: DayOff };
    expect(dayOff).toEqual({
      id: expect.any(String),
      label: 'Thanksgiving',
      startDate: '2026-11-26',
      endDate: '2026-11-26',
      assigneeName: null,
    });
    expect(await list(app)).toEqual([dayOff]);
  });

  it('creates a per-assignee range, trimming the label and assignee', async () => {
    const { app } = setup();
    const res = await app.request(
      '/api/days-off',
      send('POST', { label: '  Alex Out ', startDate: '2026-12-21', endDate: '2026-12-31', assigneeName: ' Alex ' }),
    );
    expect(res.status).toBe(201);
    expect(await list(app)).toEqual([
      expect.objectContaining({ label: 'Alex Out', endDate: '2026-12-31', assigneeName: 'Alex' }),
    ]);
  });

  it('treats a blank assigneeName as company-wide', async () => {
    const { app } = setup();
    await app.request('/api/days-off', send('POST', { ...THANKSGIVING, assigneeName: '  ' }));
    expect((await list(app))[0].assigneeName).toBeNull();
  });

  it('shares the calendar across users', async () => {
    const { app } = setup();
    await app.request('/api/days-off', send('POST', THANKSGIVING, 'alice'));
    expect(await list(app, 'bob')).toHaveLength(1);
  });

  it('accepts a range of exactly 366 days', async () => {
    const { app } = setup();
    const res = await app.request(
      '/api/days-off',
      send('POST', { label: 'Sabbatical', startDate: '2028-01-01', endDate: '2028-12-31' }),
    );
    expect(res.status).toBe(201);
  });
});

describe('days off: validation', () => {
  it.each([
    ['body not an object', '[]'],
    ['body not JSON', 'nope'],
    ['label missing', { startDate: '2026-11-26' }],
    ['label not a string', { label: 5, startDate: '2026-11-26' }],
    ['label blank', { label: '   ', startDate: '2026-11-26' }],
    ['label too long', { label: 'x'.repeat(201), startDate: '2026-11-26' }],
    ['startDate missing', { label: 'x' }],
    ['startDate wrong format', { label: 'x', startDate: '26-11-2026' }],
    ['startDate not a real date', { label: 'x', startDate: '2026-02-30' }],
    ['startDate not a string', { label: 'x', startDate: 20261126 }],
    ['endDate wrong format', { label: 'x', startDate: '2026-11-26', endDate: 'tomorrow' }],
    ['endDate not a real date', { label: 'x', startDate: '2026-11-26', endDate: '2026-13-01' }],
    ['endDate before startDate', { label: 'x', startDate: '2026-11-26', endDate: '2026-11-25' }],
    ['range over 366 days', { label: 'x', startDate: '2028-01-01', endDate: '2029-01-01' }],
    ['assigneeName not a string', { label: 'x', startDate: '2026-11-26', assigneeName: 7 }],
    ['assigneeName too long', { label: 'x', startDate: '2026-11-26', assigneeName: 'a'.repeat(201) }],
  ])('POST returns 400 for %s', async (_name, body) => {
    const { app, store } = setup();
    const res = await app.request('/api/days-off', send('POST', body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(await store.listDaysOff()).toEqual([]);
  });

  it('returns 413 for an oversized body', async () => {
    const { app } = setup();
    const res = await app.request('/api/days-off', send('POST', { ...THANKSGIVING, pad: 'x'.repeat(20_000) }));
    expect(res.status).toBe(413);
  });

  it('returns 409 once the calendar is full', async () => {
    const store = createMemoryStore();
    for (let i = 0; i < 1000; i++) {
      await store.addDayOff('s', {
        label: `d${i}`,
        startDate: '2026-11-26',
        endDate: '2026-11-26',
        assigneeName: null,
      });
    }
    const { app } = setup(store);
    const res = await app.request('/api/days-off', send('POST', THANKSGIVING));
    expect(res.status).toBe(409);
    expect(await store.listDaysOff()).toHaveLength(1000);
  });
});

describe('days off: delete', () => {
  it('removes an entry, then returns 404 for it', async () => {
    const { app } = setup();
    const created = await app.request('/api/days-off', send('POST', THANKSGIVING));
    const { dayOff } = (await created.json()) as { dayOff: DayOff };

    const res = await app.request(`/api/days-off/${dayOff.id}`, send('DELETE', undefined, 'bob'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await list(app)).toEqual([]);

    const again = await app.request(`/api/days-off/${dayOff.id}`, send('DELETE'));
    expect(again.status).toBe(404);
  });

  it('returns 404 for an unknown id and 400 for a malformed one', async () => {
    const { app } = setup();
    expect((await app.request('/api/days-off/unknown-id', send('DELETE'))).status).toBe(404);
    expect((await app.request(`/api/days-off/${'a'.repeat(129)}`, send('DELETE'))).status).toBe(400);
    expect((await app.request('/api/days-off/a.b', send('DELETE'))).status).toBe(400);
  });
});

describe('days off: middleware and errors', () => {
  it('requires an identity', async () => {
    const { app } = setup();
    expect((await app.request('/api/days-off')).status).toBe(401);
    expect((await app.request('/api/days-off', { method: 'POST', headers: { origin: ORIGIN } })).status).toBe(401);
  });

  it('rejects writes from another origin', async () => {
    const { app, store } = setup();
    const headers = { ...as(), origin: 'https://evil.example.com', 'content-type': 'application/json' };
    const post = await app.request('/api/days-off', {
      method: 'POST',
      headers,
      body: JSON.stringify(THANKSGIVING),
    });
    expect(post.status).toBe(403);
    expect(await store.listDaysOff()).toEqual([]);

    const added = await store.addDayOff('s', {
      label: 'x',
      startDate: '2026-11-26',
      endDate: '2026-11-26',
      assigneeName: null,
    });
    const del = await app.request(`/api/days-off/${added.id}`, { method: 'DELETE', headers });
    expect(del.status).toBe(403);
    expect(await store.listDaysOff()).toHaveLength(1);
  });

  it('returns a JSON 500 when the store fails', async () => {
    const store = createMemoryStore();
    store.listDaysOff = async () => {
      throw new Error('boom');
    };
    const { app } = setup(store);
    const res = await app.request('/api/days-off', { headers: as() });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
  });
});

describe('days off: legacy /api/non-work-days alias', () => {
  it('serves the previous path with the previous JSON keys, over the same data', async () => {
    const { app } = setup();

    const created = await app.request('/api/non-work-days', send('POST', THANKSGIVING));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { nonWorkDay: DayOff };
    expect(body.nonWorkDay).toMatchObject({ label: 'Thanksgiving', startDate: '2026-11-26', assigneeName: null });

    const legacyList = await app.request('/api/non-work-days', { headers: as() });
    expect(await legacyList.json()).toEqual({ nonWorkDays: [body.nonWorkDay] });
    expect(await list(app)).toEqual([body.nonWorkDay]);

    const removed = await app.request(`/api/non-work-days/${body.nonWorkDay.id}`, send('DELETE'));
    expect(removed.status).toBe(200);
    expect(await list(app)).toEqual([]);
  });

  it('keeps the new path on the new JSON keys', async () => {
    const { app } = setup();
    const created = await app.request('/api/days-off', send('POST', THANKSGIVING));
    expect(Object.keys((await created.json()) as object)).toEqual(['dayOff']);
    const listed = await app.request('/api/days-off', { headers: as() });
    expect(Object.keys((await listed.json()) as object)).toEqual(['daysOff']);
  });

  it('serves valid requests and applies the same auth, origin and validation checks', async () => {
    const { app } = setup();
    // The 401 and 403 below come from the shared /api/* middleware and hold even without the alias,
    // so first prove the alias itself answers: an authorised request must succeed.
    expect((await app.request('/api/non-work-days', { headers: as() })).status).toBe(200);
    expect((await app.request('/api/non-work-days', send('POST', THANKSGIVING))).status).toBe(201);
    expect((await app.request('/api/non-work-days')).status).toBe(401);
    const crossOrigin = await app.request('/api/non-work-days', {
      method: 'POST',
      headers: { ...as(), origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify(THANKSGIVING),
    });
    expect(crossOrigin.status).toBe(403);
    const bad = await app.request('/api/non-work-days', send('POST', { ...THANKSGIVING, startDate: '2026-02-31' }));
    expect(bad.status).toBe(400);
  });
});
