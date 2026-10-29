import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import type { Config } from '../src/config.js';
import { UnauthorizedError, type Identity } from '../src/identity.js';
import { LinearReauthRequired, type LinearOAuth } from '../src/linear/oauth.js';
import { createMemoryStore } from '../src/store/memory.js';
import type { LinearTokens, Store } from '../src/store/types.js';

const ORIGIN = 'https://gantt.example.com';
const USER: Identity = { sub: 'accounts.google.com:1', email: 'someone@bluecore.energy' };
const TOKENS: LinearTokens = { accessToken: 'access-0', refreshToken: 'refresh-0', expiresAt: null };
const RECONNECT = { error: 'Linear authentication expired. Please reconnect.', reconnect: true };

const config: Config = {
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

/** Requests carrying `x-test-user` are authenticated as USER; anything else is rejected. */
const identify: AppDeps['identify'] = async (req) => {
  if (req.headers.get('x-test-user') === null) throw new UnauthorizedError('Missing IAP assertion');
  return { ...USER };
};

interface OAuthStub extends LinearOAuth {
  exchanged: string[];
  refreshed: string[];
  revoked: string[];
}

function stubOAuth(overrides: Partial<LinearOAuth> = {}): OAuthStub {
  let issued = 0;
  const stub: OAuthStub = {
    exchanged: [],
    refreshed: [],
    revoked: [],
    authorizeUrl: (state) => `https://linear.app/oauth/authorize?state=${state}`,
    async exchangeCode(code) {
      stub.exchanged.push(code);
      return { accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: null };
    },
    async refresh(refreshToken) {
      stub.refreshed.push(refreshToken);
      issued++;
      return { accessToken: `access-${issued}`, refreshToken: `refresh-${issued}`, expiresAt: null };
    },
    async revoke(token) {
      stub.revoked.push(token);
    },
    ...overrides,
  };
  return stub;
}

interface LinearCall {
  url: string;
  authorization: string | null;
  body: unknown;
}

/** A stub Linear GraphQL endpoint answering with `replies` in order (the last one repeats). */
function stubFetch(replies: (() => Response)[]) {
  const calls: LinearCall[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get('authorization'),
      body: JSON.parse(String(init?.body)),
    });
    return replies[Math.min(calls.length - 1, replies.length - 1)]();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function setup(opts: { oauth?: OAuthStub; replies?: (() => Response)[]; store?: Store } = {}) {
  const store = opts.store ?? createMemoryStore();
  const oauth = opts.oauth ?? stubOAuth();
  const linear = stubFetch(opts.replies ?? [json({ data: { viewer: { id: 'u1' } } })]);
  const app = createApp({ config, identify, store, oauth, fetch: linear.fetch });
  return { app, store, oauth, linear };
}

const authed = (headers: Record<string, string> = {}) => ({ 'x-test-user': '1', ...headers });
const post = (body: string, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: authed({ origin: ORIGIN, 'content-type': 'application/json', ...headers }),
  body,
});

/** The `linear_oauth_state` value from a Set-Cookie header. */
function stateFrom(res: Response): string {
  const match = /linear_oauth_state=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
  if (!match) throw new Error('no state cookie');
  return match[1];
}

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorLog.mockRestore();
});

describe('identity middleware', () => {
  it('returns 401 on /api/me without an identity', async () => {
    const { app } = setup();
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it.each([
    ['GET', '/api/linear/authorize'],
    ['GET', '/api/linear/callback?code=c&state=s'],
    ['POST', '/api/linear/disconnect'],
    ['POST', '/api/linear/graphql'],
    ['GET', '/api/unknown'],
  ])('returns 401 on %s %s without an identity', async (method, path) => {
    const { app, oauth, linear } = setup();
    const res = await app.request(path, { method, headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect(oauth.exchanged).toEqual([]);
    expect(oauth.revoked).toEqual([]);
    expect(linear.calls).toEqual([]);
  });

  it('logs the failure reason and its cause, never the assertion', async () => {
    const assertion = 'eyJhbGciOiJFUzI1NiJ9.secret-payload.sig';
    const cause = Object.assign(new Error('JWKS request timed out'), { code: 'ERR_JWKS_TIMEOUT' });
    const app = createApp({
      config,
      store: createMemoryStore(),
      oauth: stubOAuth(),
      identify: async () => {
        throw new UnauthorizedError('Invalid IAP assertion (ERR_JWKS_TIMEOUT)', { cause });
      },
    });
    const res = await app.request('/api/me', { headers: { 'x-goog-iap-jwt-assertion': assertion } });
    expect(res.status).toBe(401);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain('Invalid IAP assertion (ERR_JWKS_TIMEOUT)');
    expect(logged).toContain('ERR_JWKS_TIMEOUT');
    expect(logged).toContain('JWKS request timed out');
    expect(logged).not.toContain(assertion);
  });

  it('fails closed when identify throws something other than UnauthorizedError', async () => {
    const app = createApp({
      config,
      store: createMemoryStore(),
      oauth: stubOAuth(),
      identify: async () => {
        throw new TypeError('boom');
      },
    });
    const res = await app.request('/api/me', { headers: authed() });
    expect([401, 500]).toContain(res.status);
    expect(await res.text()).not.toContain('someone@');
    expect(errorLog).toHaveBeenCalled();
  });
});

describe('origin check', () => {
  it('rejects a POST from another origin with 403', async () => {
    const { app, oauth, store } = setup();
    await store.saveTokens(USER.sub, USER.email, TOKENS);
    const res = await app.request('/api/linear/disconnect', {
      method: 'POST',
      headers: authed({ origin: 'https://evil.example' }),
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'bad origin' });
    expect(oauth.revoked).toEqual([]);
    await expect(store.getTokens(USER.sub)).resolves.toEqual(TOKENS);
  });

  it('rejects a POST with no Origin with 403', async () => {
    const { app, linear } = setup();
    const res = await app.request('/api/linear/graphql', {
      method: 'POST',
      headers: authed({ 'content-type': 'application/json' }),
      body: JSON.stringify({ query: '{ viewer { id } }' }),
    });
    expect(res.status).toBe(403);
    expect(linear.calls).toEqual([]);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('rejects %s with a foreign origin', async (method) => {
    const { app } = setup();
    const res = await app.request('/api/me', { method, headers: authed({ origin: 'https://evil.example' }) });
    expect(res.status).toBe(403);
  });

  it.each([`${ORIGIN}/`, 'https://gantt.example.com:444', 'http://gantt.example.com', 'null'])(
    'rejects the near-miss origin %s',
    async (origin) => {
      const { app } = setup();
      const res = await app.request('/api/linear/disconnect', { method: 'POST', headers: authed({ origin }) });
      expect(res.status).toBe(403);
    },
  );

  it('does not require Origin on GET', async () => {
    const { app } = setup();
    const res = await app.request('/api/me', { headers: authed() });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/me', () => {
  it('reports whether Linear is connected, before and after saveTokens', async () => {
    const { app, store } = setup();
    let res = await app.request('/api/me', { headers: authed() });
    await expect(res.json()).resolves.toEqual({ email: USER.email, linearConnected: false });

    await store.saveTokens(USER.sub, USER.email, TOKENS);
    res = await app.request('/api/me', { headers: authed() });
    await expect(res.json()).resolves.toEqual({ email: USER.email, linearConnected: true });
  });
});

describe('GET /api/linear/authorize', () => {
  it('sets the state cookie and redirects to Linear', async () => {
    const { app } = setup();
    const res = await app.request('/api/linear/authorize', { headers: authed() });
    expect(res.status).toBe(302);
    const state = stateFrom(res);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers.get('location')).toBe(`https://linear.app/oauth/authorize?state=${state}`);

    const cookie = res.headers.get('set-cookie') ?? '';
    const attrs = cookie.split(';').map((s) => s.trim());
    expect(attrs).toEqual(
      expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/linear', 'Max-Age=600']),
    );
  });

  it('uses a different state each time', async () => {
    const { app } = setup();
    const a = stateFrom(await app.request('/api/linear/authorize', { headers: authed() }));
    const b = stateFrom(await app.request('/api/linear/authorize', { headers: authed() }));
    expect(a).not.toBe(b);
  });
});

describe('GET /api/linear/callback', () => {
  const STATE = 'a'.repeat(64);

  async function callback(app: ReturnType<typeof setup>['app'], query: string, cookieState: string | null = STATE) {
    const headers = authed(cookieState === null ? {} : { cookie: `linear_oauth_state=${cookieState}` });
    return app.request(`/api/linear/callback?${query}`, { headers });
  }

  function expectCookieCleared(res: Response) {
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^linear_oauth_state=;/);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Path=/api/linear');
  }

  it('saves tokens and redirects to /app when the state matches', async () => {
    const { app, store, oauth } = setup();
    const res = await callback(app, `code=the-code&state=${STATE}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app');
    expect(oauth.exchanged).toEqual(['the-code']);
    await expect(store.getTokens(USER.sub)).resolves.toEqual({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      expiresAt: null,
    });
    expectCookieCleared(res);
  });

  it('redirects with invalid_state and saves nothing when the state does not match', async () => {
    const { app, store, oauth } = setup();
    const res = await callback(app, `code=the-code&state=${'b'.repeat(64)}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app?linear_error=invalid_state');
    expect(oauth.exchanged).toEqual([]);
    await expect(store.getTokens(USER.sub)).resolves.toBeNull();
    expectCookieCleared(res);
  });

  it.each([
    ['no cookie', `code=c&state=${STATE}`, null],
    ['no state param', 'code=c', STATE],
    ['a shorter state', `code=c&state=${STATE.slice(1)}`, STATE],
    ['an empty state and cookie', 'code=c&state=', ''],
  ])('redirects with invalid_state on %s', async (_name, query, cookieState) => {
    const { app, store, oauth } = setup();
    const res = await callback(app, query, cookieState);
    expect(res.headers.get('location')).toBe('/app?linear_error=invalid_state');
    expect(oauth.exchanged).toEqual([]);
    await expect(store.getTokens(USER.sub)).resolves.toBeNull();
    expectCookieCleared(res);
  });

  it('passes through error=access_denied (Review Focus 5)', async () => {
    const { app, store, oauth } = setup();
    const res = await callback(app, `error=access_denied&state=${STATE}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app?linear_error=access_denied');
    expect(oauth.exchanged).toEqual([]);
    await expect(store.getTokens(USER.sub)).resolves.toBeNull();
    expectCookieCleared(res);
  });

  it.each(['https://evil.example', 'Access Denied', 'x&next=//evil', 'a'.repeat(65)])(
    'never reflects an unexpected error value (%s)',
    async (error) => {
      const { app } = setup();
      const res = await callback(app, `error=${encodeURIComponent(error)}&state=${STATE}`);
      expect(res.headers.get('location')).toBe('/app?linear_error=oauth_error');
      expectCookieCleared(res);
    },
  );

  it('redirects with exchange_failed when the code exchange fails', async () => {
    const oauth = stubOAuth({
      exchangeCode: async () => {
        throw new Error('Linear token request (authorization_code) failed: HTTP 400 invalid_grant');
      },
    });
    const { app, store } = setup({ oauth });
    const res = await callback(app, `code=c&state=${STATE}`);
    expect(res.headers.get('location')).toBe('/app?linear_error=exchange_failed');
    await expect(store.getTokens(USER.sub)).resolves.toBeNull();
    expectCookieCleared(res);
  });

  it('redirects with exchange_failed when the code is missing', async () => {
    const { app, oauth } = setup();
    const res = await callback(app, `state=${STATE}`);
    expect(res.headers.get('location')).toBe('/app?linear_error=exchange_failed');
    expect(oauth.exchanged).toEqual([]);
    expectCookieCleared(res);
  });
});

describe('POST /api/linear/disconnect', () => {
  it('revokes both tokens at Linear and clears the store', async () => {
    const { app, store, oauth } = setup();
    await store.saveTokens(USER.sub, USER.email, TOKENS);
    const res = await app.request('/api/linear/disconnect', { method: 'POST', headers: authed({ origin: ORIGIN }) });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(oauth.revoked.sort()).toEqual(['access-0', 'refresh-0']);
    await expect(store.getTokens(USER.sub)).resolves.toBeNull();
  });

  it('skips a missing refresh token', async () => {
    const { app, store, oauth } = setup();
    await store.saveTokens(USER.sub, USER.email, { ...TOKENS, refreshToken: null });
    await app.request('/api/linear/disconnect', { method: 'POST', headers: authed({ origin: ORIGIN }) });
    expect(oauth.revoked).toEqual(['access-0']);
    await expect(store.getTokens(USER.sub)).resolves.toBeNull();
  });

  it('succeeds when not connected', async () => {
    const { app, oauth } = setup();
    const res = await app.request('/api/linear/disconnect', { method: 'POST', headers: authed({ origin: ORIGIN }) });
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(oauth.revoked).toEqual([]);
  });
});

describe('POST /api/linear/graphql', () => {
  const QUERY = { query: 'query($id: String!) { issue(id: $id) { id } }', variables: { id: 'ISS-1' } };

  async function connected(opts: Parameters<typeof setup>[0] = {}) {
    const ctx = setup(opts);
    await ctx.store.saveTokens(USER.sub, USER.email, TOKENS);
    return ctx;
  }

  it('relays query and variables with the bearer token and passes through a 200', async () => {
    const { app, linear } = await connected();
    const res = await app.request('/api/linear/graphql', post(JSON.stringify({ ...QUERY, extra: 'dropped' })));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { viewer: { id: 'u1' } } });
    expect(linear.calls).toEqual([
      { url: 'https://api.linear.app/graphql', authorization: 'Bearer access-0', body: QUERY },
    ]);
  });

  it('passes through a 429 with retry-after', async () => {
    const limited = { errors: [{ message: 'Rate limited', extensions: { code: 'RATELIMITED' } }] };
    const { app } = await connected({ replies: [json(limited, 429, { 'retry-after': '3' })] });
    const res = await app.request('/api/linear/graphql', post(JSON.stringify(QUERY)));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3');
    await expect(res.json()).resolves.toEqual(limited);
  });

  it('passes through a GraphQL error body with its 400 status', async () => {
    const body = { errors: [{ message: 'Syntax Error' }] };
    const { app } = await connected({ replies: [json(body, 400)] });
    const res = await app.request('/api/linear/graphql', post(JSON.stringify(QUERY)));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual(body);
  });

  it('force-refreshes and retries once on a Linear 401, then returns the 200', async () => {
    const { app, store, oauth, linear } = await connected({
      replies: [json({ error: 'unauthorized' }, 401), json({ data: { ok: true } })],
    });
    const res = await app.request('/api/linear/graphql', post(JSON.stringify(QUERY)));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { ok: true } });
    expect(oauth.refreshed).toEqual(['refresh-0']);
    expect(linear.calls.map((c) => c.authorization)).toEqual(['Bearer access-0', 'Bearer access-1']);
    expect((await store.getTokens(USER.sub))?.accessToken).toBe('access-1');
  });

  it('clears the tokens and asks to reconnect when Linear returns 401 twice (Review Focus 3)', async () => {
    const { app, store, linear } = await connected({ replies: [json({ error: 'unauthorized' }, 401)] });
    const res = await app.request('/api/linear/graphql', post(JSON.stringify(QUERY)));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(RECONNECT);
    expect(linear.calls).toHaveLength(2);
    await expect(store.getTokens(USER.sub)).resolves.toBeNull();
  });

  it('asks to reconnect when not connected', async () => {
    const { app, linear } = setup();
    const res = await app.request('/api/linear/graphql', post(JSON.stringify(QUERY)));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(RECONNECT);
    expect(linear.calls).toEqual([]);
  });

  it('asks to reconnect when the forced refresh needs reauthorization', async () => {
    const oauth = stubOAuth({
      refresh: async () => {
        throw new LinearReauthRequired();
      },
    });
    const { app, store } = await connected({ oauth, replies: [json({}, 401)] });
    const res = await app.request('/api/linear/graphql', post(JSON.stringify(QUERY)));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(RECONNECT);
    await expect(store.getTokens(USER.sub)).resolves.toBeNull();
  });

  it('returns 502 and keeps the tokens when the refresh fails for another reason', async () => {
    const oauth = stubOAuth({
      refresh: async () => {
        throw new Error('Linear token request (refresh_token) failed: HTTP 500');
      },
    });
    const { app, store } = await connected({ oauth, replies: [json({}, 401)] });
    const res = await app.request('/api/linear/graphql', post(JSON.stringify(QUERY)));
    expect(res.status).toBe(502);
    await expect(store.getTokens(USER.sub)).resolves.toEqual(TOKENS);
  });

  it('returns 413 for a body over 1 MB', async () => {
    const { app, linear } = await connected();
    const big = JSON.stringify({ query: 'x'.repeat(1024 * 1024) });
    const res = await app.request('/api/linear/graphql', post(big));
    expect(res.status).toBe(413);
    expect(linear.calls).toEqual([]);
  });

  it('returns 413 for a streamed body over 1 MB with no Content-Length', async () => {
    const { app, linear } = await connected();
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 20) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const req = new Request(`http://localhost/api/linear/graphql`, {
      method: 'POST',
      headers: authed({ origin: ORIGIN, 'content-type': 'application/json' }),
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(req.headers.get('content-length')).toBeNull();
    const res = await app.request(req);
    expect(res.status).toBe(413);
    expect(linear.calls).toEqual([]);
  });

  it('accepts a body just under 1 MB', async () => {
    const { app } = await connected();
    const body = JSON.stringify({ query: 'x'.repeat(1024 * 1024 - 20) });
    expect(body.length).toBeLessThanOrEqual(1024 * 1024);
    const res = await app.request('/api/linear/graphql', post(body));
    expect(res.status).toBe(200);
  });

  it.each([
    ['invalid JSON', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a missing query', '{"variables":{}}'],
    ['a non-string query', '{"query":42}'],
    ['non-object variables', '{"query":"{ a }","variables":"x"}'],
  ])('returns 400 for %s', async (_name, body) => {
    const { app, linear } = await connected();
    const res = await app.request('/api/linear/graphql', post(body));
    expect(res.status).toBe(400);
    expect(linear.calls).toEqual([]);
  });

  it('returns 502 when Linear cannot be reached', async () => {
    const { app } = await connected({
      replies: [
        () => {
          throw new TypeError('fetch failed');
        },
      ],
    });
    const res = await app.request('/api/linear/graphql', post(JSON.stringify(QUERY)));
    expect(res.status).toBe(502);
  });

  it('never logs tokens or request bodies', async () => {
    const { app } = await connected({ replies: [json({}, 401)] });
    await app.request('/api/linear/graphql', post(JSON.stringify({ query: 'secret-query-text' })));
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain('access-');
    expect(logged).not.toContain('refresh-');
    expect(logged).not.toContain('secret-query-text');
  });
});
