import { Firestore } from '@google-cloud/firestore';
import { serve } from '@hono/node-server';
import { createApp, type AppDeps } from './app.js';
import { loadConfig } from './config.js';
import { createDevIdentity, createIapVerifier } from './identity.js';
import { createLinearOAuth } from './linear/oauth.js';
import { log } from './log.js';
import { createShutdownHandler } from './shutdown.js';
import { createFirestoreStore } from './store/firestore.js';
import { createMemoryStore } from './store/memory.js';
import type { Store } from './store/types.js';

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
  log.info('server started', {
    mode: devMode ? 'dev' : 'iap',
    store: devMode ? 'memory' : 'firestore',
    port: info.port,
  });
});

const shutdown = createShutdownHandler(server);

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
