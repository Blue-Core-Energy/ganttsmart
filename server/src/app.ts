import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Config } from './config.js';
import { UnauthorizedError, type Identity } from './identity.js';
import type { LinearOAuth } from './linear/oauth.js';
import { createTokenService } from './linear/tokens.js';
import { historyRoutes } from './routes/history.js';
import { linearRoutes } from './routes/linear.js';
import type { Store } from './store/types.js';

export interface AppDeps {
  config: Config;
  /** Resolves the IAP-authenticated user for a request; throws UnauthorizedError otherwise. */
  identify: (req: Request) => Promise<Identity>;
  store: Store;
  oauth: LinearOAuth;
  /** Used for calls to Linear's GraphQL API. */
  fetch?: typeof fetch;
}

export interface AppEnv {
  Variables: { identity: Identity };
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Vite's hashed build output: safe to cache forever. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Everything else (index.html, public/ files) must be revalidated so deploys take effect. */
const NO_CACHE = 'no-cache';

/**
 * Serves files under `root` with the given Cache-Control; falls through to the next handler when
 * no file matches. serveStatic refuses `..` segments, backslashes and any percent-encoding in the
 * path, so a request cannot reach files outside `root`.
 */
function staticFiles(root: string, cacheControl: string): MiddlewareHandler<AppEnv> {
  const serve = serveStatic<AppEnv>({ root });
  return async (c, next) => {
    let missing = false;
    const res = await serve(c, async () => {
      missing = true;
    });
    if (missing || !res) return next();
    res.headers.set('Cache-Control', cacheControl);
    return res;
  };
}

/** The error's message and its cause's code and message. Never includes the request or assertion. */
function describeFailure(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: typeof err };
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  const cause = err.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    out.cause = { name: cause.name, message: cause.message, ...(typeof code === 'string' ? { code } : {}) };
  }
  return out;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { config, identify, store, oauth } = deps;
  const tokens = createTokenService({ store, oauth });
  const app = new Hono<AppEnv>();

  // Anything a route does not handle itself is a JSON 500. Logs only the error's name, message and
  // cause code: never the stack, the request or any token.
  app.onError((err, c) => {
    console.error('Request failed', describeFailure(err));
    return c.json({ error: 'internal error' }, 500);
  });

  // 1. Every /api route requires an IAP identity. Any failure, expected or not, fails closed.
  app.use('/api/*', async (c, next) => {
    let identity: Identity;
    try {
      identity = await identify(c.req.raw);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        console.error('IAP identity check failed', describeFailure(err));
        return c.json({ error: 'unauthorized' }, 401);
      }
      console.error('IAP identity check errored', describeFailure(err));
      return c.json({ error: 'internal error' }, 500);
    }
    c.set('identity', identity);
    await next();
  });

  // 2. State-changing requests must come from the app itself (cross-site request protection).
  app.use('/api/*', async (c, next) => {
    if (UNSAFE_METHODS.has(c.req.method) && c.req.header('origin') !== config.appOrigin) {
      return c.json({ error: 'bad origin' }, 403);
    }
    await next();
  });

  app.get('/api/me', async (c) => {
    const { sub, email } = c.get('identity');
    const linearConnected = (await store.getTokens(sub)) !== null;
    return c.json({ email, linearConnected });
  });

  app.route('/api/linear', linearRoutes({ store, oauth, tokens, fetch: deps.fetch ?? globalThis.fetch }));
  app.route('/api/history', historyRoutes({ store }));

  // Unknown API routes are a JSON 404, never the SPA shell. This must stay after every /api route.
  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  // 3. The built React app. Not behind the identity middleware: IAP protects it in production.
  const root = config.staticDir;
  app.use('/assets/*', staticFiles(root, IMMUTABLE));
  // A missing hashed asset is a 404: answering with index.html would hand HTML to a <script> tag.
  app.get('/assets/*', (c) => c.text('not found', 404));
  app.use('*', staticFiles(root, NO_CACHE));

  // SPA fallback: client-side routes such as /app get the shell.
  const indexPath = join(root, 'index.html');
  app.get('*', async (c) => {
    let html: string;
    try {
      html = await readFile(indexPath, 'utf8');
    } catch {
      return c.text('not found', 404);
    }
    c.header('Cache-Control', NO_CACHE);
    return c.html(html);
  });

  return app;
}
