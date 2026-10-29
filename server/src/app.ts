import { Hono } from 'hono';
import type { Config } from './config.js';
import { UnauthorizedError, type Identity } from './identity.js';
import type { LinearOAuth } from './linear/oauth.js';
import { createTokenService } from './linear/tokens.js';
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

  return app;
}
