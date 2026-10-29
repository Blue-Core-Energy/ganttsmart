import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import { createApp, type AppDeps } from './app.js';
import { loadConfig } from './config.js';
import { createDevIdentity, createIapVerifier } from './identity.js';
import { createLinearOAuth } from './linear/oauth.js';
import { createFirestoreStore } from './store/firestore.js';
import { createMemoryStore } from './store/memory.js';
import type { Store } from './store/types.js';

/** Cloud Run allows 10 seconds after SIGTERM; exit before it kills the instance. */
const SHUTDOWN_GRACE_MS = 8_000;

/** One structured log line on stdout (Cloud Logging parses JSON lines). */
function log(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const config = loadConfig(process.env);
const devMode = config.devUserEmail !== null;

let identify: AppDeps['identify'];
let store: Store;
if (config.devUserEmail !== null) {
  identify = createDevIdentity(config.devUserEmail);
  store = createMemoryStore();
} else {
  // loadConfig guarantees IAP_AUDIENCE is set whenever DEV_USER_EMAIL is not.
  const audience = config.iapAudience;
  if (audience === null) throw new Error('IAP_AUDIENCE is required');
  const verify = createIapVerifier({ audience, allowedDomain: config.allowedDomain });
  identify = (req) => verify(req.headers.get('x-goog-iap-jwt-assertion') ?? undefined);
  store = createFirestoreStore(new Firestore());
}

const oauth = createLinearOAuth({
  clientId: config.linearClientId,
  clientSecret: config.linearClientSecret,
  redirectUri: config.linearRedirectUri,
});

const app = createApp({ config, identify, store, oauth });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log({
    severity: 'INFO',
    message: 'server started',
    mode: devMode ? 'dev' : 'iap',
    store: devMode ? 'memory' : 'firestore',
    port: info.port,
  });
});

function shutdown(signal: string): void {
  log({ severity: 'INFO', message: 'shutting down', signal });
  // Stop accepting connections and let in-flight requests finish, but never hang past the grace period.
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  server.close((err) => {
    if (err) console.error('Error closing server', err.message);
    process.exit(err ? 1 : 0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
