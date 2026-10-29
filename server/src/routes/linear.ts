import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app.js';
import { LinearReauthRequired, type LinearOAuth } from '../linear/oauth.js';
import type { TokenService } from '../linear/tokens.js';
import type { Store } from '../store/types.js';

const GRAPHQL_URL = 'https://api.linear.app/graphql';
const GRAPHQL_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;

const STATE_COOKIE = 'linear_oauth_state';
const STATE_COOKIE_PATH = '/api/linear';
const STATE_MAX_AGE_S = 600;

const RECONNECT = { error: 'Linear authentication expired. Please reconnect.', reconnect: true } as const;

export interface LinearRouteDeps {
  store: Store;
  oauth: LinearOAuth;
  tokens: TokenService;
  fetch: typeof fetch;
}

/** Constant-time string comparison; strings of different lengths never match. */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Linear's OAuth error code if it looks like one, so arbitrary text is never put in a redirect. */
function oauthErrorCode(error: string): string {
  return /^[a-z_]{1,64}$/.test(error) ? error : 'oauth_error';
}

/** Error name and message only; callers pass errors whose messages never contain secrets. */
function reason(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
}

/**
 * Reads the request body as text, stopping as soon as it exceeds `limit` bytes. Counts the bytes
 * actually received, so a missing or false Content-Length cannot get past the limit.
 */
async function readBody(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown> | null;
}

/** Keeps only `query` and `variables`; null if the body is not a GraphQL request. */
function parseGraphQLRequest(text: string): GraphQLRequest | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { query, variables } = body as Record<string, unknown>;
  if (typeof query !== 'string') return null;
  if (variables === undefined) return { query };
  if (variables !== null && (typeof variables !== 'object' || Array.isArray(variables))) return null;
  return { query, variables: variables as Record<string, unknown> | null };
}

export function linearRoutes(deps: LinearRouteDeps): Hono<AppEnv> {
  const { store, oauth, tokens, fetch: doFetch } = deps;
  const routes = new Hono<AppEnv>();

  routes.get('/authorize', (c) => {
    const state = randomBytes(32).toString('hex');
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: STATE_COOKIE_PATH,
      maxAge: STATE_MAX_AGE_S,
    });
    return c.redirect(oauth.authorizeUrl(state), 302);
  });

  routes.get('/callback', async (c) => {
    const expected = getCookie(c, STATE_COOKIE);
    // The state is single use: clear it whatever happens next.
    deleteCookie(c, STATE_COOKIE, { path: STATE_COOKIE_PATH, httpOnly: true, secure: true, sameSite: 'Lax' });
    const fail = (code: string) => c.redirect(`/app?linear_error=${code}`, 302);

    const error = c.req.query('error');
    if (error !== undefined) return fail(oauthErrorCode(error));

    const state = c.req.query('state');
    if (!expected || !state || !safeEqual(state, expected)) return fail('invalid_state');

    const code = c.req.query('code');
    if (!code) return fail('exchange_failed');

    const { sub, email } = c.get('identity');
    try {
      const linearTokens = await oauth.exchangeCode(code);
      await store.saveTokens(sub, email, linearTokens);
    } catch (err) {
      console.error('Linear code exchange failed', reason(err));
      return fail('exchange_failed');
    }
    return c.redirect('/app', 302);
  });

  routes.post('/disconnect', async (c) => {
    const { sub } = c.get('identity');
    const stored = await store.getTokens(sub);
    if (stored) {
      // Best effort: revoke never throws, and the local copy is cleared regardless.
      await Promise.all([
        oauth.revoke(stored.accessToken),
        stored.refreshToken !== null ? oauth.revoke(stored.refreshToken) : undefined,
      ]);
    }
    await store.clearTokens(sub);
    return c.json({ ok: true });
  });

  routes.post('/graphql', async (c) => {
    const text = await readBody(c.req.raw, MAX_BODY_BYTES);
    if (text === null) return c.json({ error: 'request body too large' }, 413);
    const request = parseGraphQLRequest(text);
    if (!request) return c.json({ error: 'expected a JSON body with a string "query"' }, 400);
    const payload = JSON.stringify(request);
    const { sub } = c.get('identity');

    const callLinear = (token: string) =>
      doFetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: payload,
        signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
      });

    try {
      let res = await callLinear(await tokens.getAccessToken(sub));
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        res = await callLinear(await tokens.getAccessToken(sub, { forceRefresh: true }));
        if (res.status === 401) {
          await res.body?.cancel().catch(() => {});
          await store.clearTokens(sub);
          return c.json(RECONNECT, 401);
        }
      }
      return await passThrough(c, res);
    } catch (err) {
      if (err instanceof LinearReauthRequired) return c.json(RECONNECT, 401);
      console.error('Linear GraphQL relay failed', reason(err));
      return c.json({ error: 'Linear request failed' }, 502);
    }
  });

  return routes;
}

/** Linear's status, JSON body and retry-after, unchanged. A non-JSON body becomes a 502. */
async function passThrough(c: Context<AppEnv>, res: Response): Promise<Response> {
  const text = await res.text();
  try {
    JSON.parse(text);
  } catch {
    console.error('Linear GraphQL returned a non-JSON body', `HTTP ${res.status}`);
    return c.json({ error: 'Linear request failed' }, 502);
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter !== null) headers['retry-after'] = retryAfter;
  return new Response(text, { status: res.status, headers });
}
