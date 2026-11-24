import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, HSTS_HEADER, SECURITY_HEADERS, type AppDeps } from '../src/app.js';
import type { Config } from '../src/config.js';
import { UnauthorizedError } from '../src/identity.js';
import type { LinearOAuth } from '../src/linear/oauth.js';
import { createMemoryStore } from '../src/store/memory.js';
import type { Store } from '../src/store/types.js';

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
  if (who === 'crash') throw new Error('Simulated crash in identify');
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
  tmp = mkdtempSync(join(tmpdir(), 'ganttsmart-app-sec-'));
  staticDir = join(tmp, 'dist');
  mkdirSync(join(staticDir, 'assets'), { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><body>SPA</body></html>');
  writeFileSync(join(staticDir, 'assets', 'bundle.12345.js'), 'console.log("bundled");');
  writeFileSync(join(staticDir, 'favicon.svg'), '<svg></svg>');
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

function setup(opts: { store?: Store; config?: Partial<Config>; fetch?: typeof fetch } = {}) {
  const store = opts.store ?? createMemoryStore();
  const config = { ...baseConfig, staticDir, ...opts.config };
  const app = createApp({ config, identify, store, oauth, fetch: opts.fetch });
  return { app, store };
}

const asAlice = { 'x-test-user': 'alice' };

describe('HTTP security headers', () => {
  const verifySecurityHeaders = (res: Response) => {
    expect(res.headers.get('Content-Security-Policy')).toBe(SECURITY_HEADERS['Content-Security-Policy']);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(res.headers.get('Content-Security-Policy')).toContain("object-src 'none'");
    expect(res.headers.get('Content-Security-Policy')).toContain("base-uri 'self'");
    expect(res.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
    expect(res.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(res.headers.get('Content-Security-Policy')).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    );
    expect(res.headers.get('Content-Security-Policy')).toContain("font-src 'self' https://fonts.gstatic.com data:");
    expect(res.headers.get('Content-Security-Policy')).toContain("img-src 'self' data: blob:");
    expect(res.headers.get('Content-Security-Policy')).toContain(
      "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
    );
    expect(res.headers.get('Content-Security-Policy')).not.toContain('https://api.linear.app');

    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  };

  it('sets security headers on successful API responses', async () => {
    const { app } = setup();
    const res = await app.request('/api/me', { headers: asAlice });
    expect(res.status).toBe(200);
    verifySecurityHeaders(res);
  });

  it('sets security headers on 401 unauthorized API responses', async () => {
    const { app } = setup();
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    verifySecurityHeaders(res);
  });

  it('sets security headers on 403 forbidden API responses', async () => {
    const { app } = setup();
    const res = await app.request('/api/days-off', {
      method: 'POST',
      headers: { ...asAlice, origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Test', startDate: '2026-12-01' }),
    });
    expect(res.status).toBe(403);
    verifySecurityHeaders(res);
  });

  it('sets security headers on 404 API responses', async () => {
    const { app } = setup();
    const res = await app.request('/api/non-existent-endpoint', { headers: asAlice });
    expect(res.status).toBe(404);
    verifySecurityHeaders(res);
  });

  it('sets security headers on 500 error responses when identify throws', async () => {
    const { app } = setup();
    const res = await app.request('/api/me', { headers: { 'x-test-user': 'crash' } });
    expect(res.status).toBe(500);
    verifySecurityHeaders(res);
  });

  it('sets security headers on 500 responses when downstream route throws (exercising app.onError)', async () => {
    const store = createMemoryStore();
    vi.spyOn(store, 'getTokens').mockRejectedValueOnce(new Error('Firestore read failed'));
    const { app } = setup({ store });

    const res = await app.request('/api/me', { headers: asAlice });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    verifySecurityHeaders(res);
  });

  it('sets security headers on hashed static assets (/assets/*)', async () => {
    const { app } = setup();
    const res = await app.request('/assets/bundle.12345.js');
    expect(res.status).toBe(200);
    verifySecurityHeaders(res);
  });

  it('sets security headers on non-hashed static files', async () => {
    const { app } = setup();
    const res = await app.request('/favicon.svg');
    expect(res.status).toBe(200);
    verifySecurityHeaders(res);
  });

  it('sets security headers on SPA fallback routes', async () => {
    const { app } = setup();
    const res = await app.request('/app');
    expect(res.status).toBe(200);
    verifySecurityHeaders(res);
  });

  describe('Strict-Transport-Security gating', () => {
    it('omits Strict-Transport-Security when isProduction is false', async () => {
      const { app } = setup({ config: { isProduction: false } });
      const res = await app.request('/api/me', { headers: asAlice });
      expect(res.status).toBe(200);
      expect(res.headers.get('Strict-Transport-Security')).toBeNull();
    });

    it('sets Strict-Transport-Security when isProduction is true', async () => {
      const { app } = setup({ config: { isProduction: true } });
      const res = await app.request('/api/me', { headers: asAlice });
      expect(res.status).toBe(200);
      expect(res.headers.get('Strict-Transport-Security')).toBe(HSTS_HEADER);
    });
  });
});

describe('Cache-Control headers', () => {
  it('sets no-store on /api/me', async () => {
    const { app } = setup();
    const res = await app.request('/api/me', { headers: asAlice });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets no-store on /api/history/baselines', async () => {
    const { app } = setup();
    const res = await app.request('/api/history/baselines?projectId=proj-1', { headers: asAlice });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets no-store on /api/days-off', async () => {
    const { app } = setup();
    const res = await app.request('/api/days-off', { headers: asAlice });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets no-store on legacy /api/non-work-days', async () => {
    const { app } = setup();
    const res = await app.request('/api/non-work-days', { headers: asAlice });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets no-store on /api/linear/authorize', async () => {
    const { app } = setup();
    const res = await app.request('/api/linear/authorize', { headers: asAlice });
    expect(res.status).toBe(302);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets no-store on POST /api/linear/graphql passThrough response', async () => {
    const store = createMemoryStore();
    await store.saveTokens('accounts.google.com:alice', 'alice@bluecore.energy', {
      accessToken: 'test-linear-token',
      refreshToken: 'test-refresh-token',
      expiresAt: null,
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { id: 'user-1' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const { app } = setup({ store, fetch: mockFetch });
    const res = await app.request('/api/linear/graphql', {
      method: 'POST',
      headers: {
        ...asAlice,
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: '{ viewer { id } }' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets no-store on 401 unauthorized API errors', async () => {
    const { app } = setup();
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets no-store on 403 CSRF bad origin errors', async () => {
    const { app } = setup();
    const res = await app.request('/api/days-off', {
      method: 'POST',
      headers: { ...asAlice, origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Test', startDate: '2026-12-01' }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets no-store on 404 API not found errors', async () => {
    const { app } = setup();
    const res = await app.request('/api/unknown', { headers: asAlice });
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets no-store on 500 internal server errors when identify throws', async () => {
    const { app } = setup();
    const res = await app.request('/api/me', { headers: { 'x-test-user': 'crash' } });
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets no-store on 500 internal server errors when route handler throws (exercising app.onError)', async () => {
    const store = createMemoryStore();
    vi.spyOn(store, 'getTokens').mockRejectedValueOnce(new Error('Database unavailable'));
    const { app } = setup({ store });

    const res = await app.request('/api/me', { headers: asAlice });
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('preserves immutable Cache-Control on hashed static assets (/assets/*)', async () => {
    const { app } = setup();
    const res = await app.request('/assets/bundle.12345.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('preserves no-cache Cache-Control on unhashed static files', async () => {
    const { app } = setup();
    const res = await app.request('/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('preserves no-cache Cache-Control on SPA fallback routes', async () => {
    const { app } = setup();
    const res = await app.request('/app');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });
});
