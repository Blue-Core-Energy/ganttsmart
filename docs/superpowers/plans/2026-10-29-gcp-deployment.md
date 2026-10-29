# GanttSmart on Google Cloud — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Google Cloud backend option (Cloud Run + IAP + Firestore) to GanttSmart, selected at build time, while keeping the Supabase setup working. Also ship two standalone Supabase fixes.

**Architecture:**
- **One Node/TypeScript server** (`server/`) checks IAP identity, handles the Linear OAuth flow, holds and renews Linear tokens, relays GraphQL calls, stores per-user planning history in Firestore, and serves the Vite build.
- **The frontend talks to its backend through a narrow seam** (`src/backend/`). The implementation is chosen at build time by a Vite alias, so the GCP bundle never loads Supabase code.

**Tech Stack:**
- **Server:** Node 22, TypeScript, Hono + `@hono/node-server`, `jose` (IAP JWT check), `@google-cloud/firestore`, Vitest
- **Frontend:** React 19, Vite 8 (existing)
- **Deployment:** Docker/Podman, Cloud Build, Cloud Run, global external ALB + IAP, Secret Manager

**Spec:** `docs/superpowers/specs/2026-10-29-gcp-deployment-design.md`

## Global Constraints

- **Backend setting:** `VITE_BACKEND=supabase|gcp`, default `supabase`. A build with no setting behaves exactly as upstream does today, plus fixes U1 and U2.
- **The GCP build** must not require any `VITE_SUPABASE_*` variable and must never create a Supabase client.
- **Tokens:** Linear access tokens, refresh tokens and the client secret never reach the browser in GCP mode.
- **Allowed domain:** `bluecore.energy`. Compare the whole domain after `@`, ignoring case.
- **IAP JWT:** header `x-goog-iap-jwt-assertion`; issuer `https://cloud.google.com/iap`; algorithm ES256; keys from `https://www.gstatic.com/iap/verify/public_key-jwk`; audience from `IAP_AUDIENCE`.
- **Users** are keyed by the IAP `sub` claim; their email is stored alongside.
- **Linear endpoints:**
  - authorize: `https://linear.app/oauth/authorize`
  - token: `https://api.linear.app/oauth/token`
  - revoke: `https://api.linear.app/oauth/revoke` (form field `token`)
  - GraphQL: `https://api.linear.app/graphql`
  - scopes: `read,write`
- **Linear tokens:** access tokens last 24h; each refresh rotates the refresh token; the old refresh token can be reused for 30 minutes. Refresh tokens within 5 minutes of expiry.
- **Production redirect URI:** `https://ganttsmart.bluecore.energy/api/linear/callback`. App origin: `https://ganttsmart.bluecore.energy`.
- **GCP:** region `us-west2`; Cloud Run service `ganttsmart`; runtime service account `ganttsmart-run`; Artifact Registry repo `ganttsmart`; Firestore Native mode in `us-west2`.
- **Production safety:** the server refuses to start with `DEV_USER_EMAIL` set when `NODE_ENV=production`.
- **Lint and types:** no new ESLint errors; `tsc` passes for the app and the server.
- **Git commits:** `git -c user.name="Andrew" -c user.email="andrew@bluecore.energy" commit`, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Pull requests:** into the fork's `main` (`origin`, Blue-Core-Energy/ganttsmart); open them as drafts. Never push to `main`.

## Review Focus

1. **IAP session expires mid-use.** `/api` calls get redirected to Google sign-in. The UI should say "Session expired — reload", not show a broken chart (test in Task 9).
2. **Two tabs or two server instances renew the same token at once.** Both requests should succeed and nobody gets kicked to "Reconnect Linear" (test in Task 5).
3. **A user's Linear access is revoked or their account deactivated.** The next relay call should clear the stored tokens and show "Reconnect Linear" (test in Task 6).
4. **Lookalike or oddly-cased emails.** `Someone@BlueCore.Energy` is accepted; `x@evil-bluecore.energy` and `x@bluecore.energy.evil.com` are rejected (test in Task 3).
5. **The user clicks Cancel on Linear's consent screen.** The callback arrives with `error=access_denied`; they should land back on the connect screen with a readable message, not a 500 (tests in Tasks 6 and 9).

---

### Task 1: Ship U1 (drop the `anon_read` policy)

Already committed on branch `fix/shared-roadmaps-anon-read`
(`supabase/migrations/007_drop_anon_read_shared_roadmaps.sql`).

- [ ] **Step 1:** Confirm no client code reads `shared_roadmaps` directly.
  Run `git grep -n "shared_roadmaps" fix/shared-roadmaps-anon-read -- src`. Expected: no output.
- [ ] **Step 2:** Push the branch.
  Run `git push -u origin fix/shared-roadmaps-anon-read`.
- [ ] **Step 3:** Open a draft PR into the fork's `main`.
  Run `gh pr create --draft --repo Blue-Core-Energy/ganttsmart --base main --head fix/shared-roadmaps-anon-read`, with a body explaining the exposure and that the Edge Function uses service_role.

### Task 2: Finish U2 (Linear token refresh, Supabase setup)

Branch `fix/linear-token-refresh` has a WIP commit containing:
- migration 008
- `supabase/functions/_shared/linear-token.ts`
- the `linear-token-refresh` function
- callback and share-roadmap changes
- `useAuth` refresh scheduling

**Files:**
- Modify: `supabase/functions/linear-token-refresh/index.ts` (add the disconnect action)
- Modify: `src/hooks/useAuth.ts` (make `disconnectLinear` use the function)
- Modify: `src/App.tsx` (on auth error, try a refresh before disconnecting)

**Interfaces:**
- **Produces:** `useAuth()` additionally returns `refreshLinearToken(): Promise<string | null>`.
- **Produces:** the `linear-token-refresh` Edge Function accepts body `{ action?: 'refresh' | 'disconnect' }`:
  - `refresh` (the default) returns `{ accessToken, expiresAt }` or `{ reconnect: true }`.
  - `disconnect` revokes the token at Linear (best effort), calls `clearLinearTokens`, and returns `{ success: true }`.

- [ ] **Step 1:** `git checkout fix/linear-token-refresh` and review the WIP diff (`git show HEAD`) against the spec's U2.
- [ ] **Step 2:** Add the `disconnect` action to `linear-token-refresh/index.ts`.
  Add `revokeLinearToken(token: string): Promise<void>` to `_shared/linear-token.ts`. It POSTs form `token=<access token>` to the revoke endpoint and ignores the result.
- [ ] **Step 3:** In `useAuth.disconnectLinear`, replace the direct `user_settings` update with `supabase.functions.invoke('linear-token-refresh', { body: { action: 'disconnect' } })`.
  If that call fails, fall back to the current direct update.
- [ ] **Step 4:** In `App.tsx`, pass `useLinearData` an `onAuthError` that first awaits `refreshLinearToken()` and only calls `disconnectLinear()` if it returns `null`.
  `GanttView` gets a new prop, `onLinearAuthError: () => Promise<void>`, for this.
- [ ] **Step 5:** Run `npx --yes deno@2 check supabase/functions/*/index.ts`.
  Expected: no type errors. If Deno can't download in the sandbox, record that in the PR body instead.
- [ ] **Step 6:** Run `npm run build && npm run lint`.
  Expected: the build succeeds; lint shows 0 errors.
- [ ] **Step 7:** Combine the WIP into one commit.
  Run `git reset --soft main`, then commit as `fix: refresh Linear OAuth tokens before they expire` with a body explaining the 24h expiry and rotation.
- [ ] **Step 8:** Push and open a draft PR into the fork's `main`.
  The body notes that the migration must be applied and the new function deployed (`supabase functions deploy linear-token-refresh`).

### Task 3: Server scaffold, config and IAP identity

First, rebase `feat/gcp-backend` onto `fix/linear-token-refresh` so the frontend seam can include U2. The PR body will note that it's stacked on U2.

**Files:**
- Modify: `package.json`:
  - add deps `hono`, `@hono/node-server`, `jose` and `@google-cloud/firestore`
  - add devDeps `vitest` and `tsx`
  - add scripts `"test": "vitest run"`, `"build:server": "tsc -p tsconfig.server.json"`, `"dev:server": "tsx watch server/src/index.ts"` and `"start": "node server-dist/index.js"`
- Create: `tsconfig.server.json`:
  - `module`/`moduleResolution` `NodeNext`, target ES2023, strict
  - `rootDir` `server/src`, `outDir` `server-dist`
  - include `server/src`
- Create: `vitest.config.ts`: Node environment, include `server/test/**/*.test.ts` and `src/**/*.test.ts`.
- Modify: `eslint.config.js` (Node globals for `server/**`), `.gitignore` (`server-dist`).
- Create: `server/src/config.ts`, `server/src/identity.ts`
- Test: `server/test/config.test.ts`, `server/test/identity.test.ts`

**Interfaces:**
- **Produces** (`config.ts`):
  - `interface Config { port: number; isProduction: boolean; appOrigin: string; allowedDomain: string; iapAudience: string | null; devUserEmail: string | null; linearClientId: string; linearClientSecret: string; linearRedirectUri: string; staticDir: string; }`
  - `loadConfig(env: Record<string, string | undefined>): Config`. It reads `PORT` (default 8080), `NODE_ENV`, `APP_ORIGIN`, `ALLOWED_EMAIL_DOMAIN` (default `bluecore.energy`), `IAP_AUDIENCE`, `DEV_USER_EMAIL`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_REDIRECT_URI` and `STATIC_DIR` (default `dist`).
- **Produces** (`identity.ts`):
  - `interface Identity { sub: string; email: string }`
  - `class UnauthorizedError extends Error`
  - `isAllowedEmail(email: string, domain: string): boolean`
  - `createIapVerifier(opts: { audience: string; allowedDomain: string; keys?: JWTVerifyGetKey }): (assertion: string | undefined) => Promise<Identity>`. It throws `UnauthorizedError`; `keys` defaults to the remote JWK set.
  - `createDevIdentity(email: string): () => Promise<Identity>`, which returns `{ sub: 'dev:' + email, email }`.

- [ ] **Step 1:** Rebase.
  Run `git checkout feat/gcp-backend && git rebase fix/linear-token-refresh`, then `npm install`.
- [ ] **Step 2:** Write failing tests in `config.test.ts`:
  - `loadConfig({NODE_ENV:'production', DEV_USER_EMAIL:'a@bluecore.energy', ...})` throws `/DEV_USER_EMAIL/`.
  - Production without `IAP_AUDIENCE` throws.
  - A missing `LINEAR_CLIENT_SECRET` throws.
  - The defaults apply.
- [ ] **Step 3:** Write failing tests in `identity.test.ts`. Sign test tokens with a local ES256 key pair (`generateKeyPair('ES256')` + `SignJWT`), passing `keys: createLocalJWKSet(...)`. Cases:
  - Valid token → `{sub, email}`.
  - Bad signature → `UnauthorizedError`.
  - Wrong `aud` → rejected.
  - Wrong `iss` → rejected.
  - Expired → rejected.
  - Missing header → rejected.
  - Email outside the domain → rejected.
  - `isAllowedEmail` matrix:
    - `Someone@BlueCore.Energy` → true
    - `x@evil-bluecore.energy` → false
    - `x@bluecore.energy.evil.com` → false
    - `bluecore.energy@gmail.com` → false
- [ ] **Step 4:** Run `npx vitest run server/test`. Expected: FAIL (modules missing).
- [ ] **Step 5:** Implement `config.ts` and `identity.ts`, using `jose`'s `jwtVerify`, `createRemoteJWKSet`, `issuer` and `audience` options.
- [ ] **Step 6:** Run `npx vitest run server/test` and `npm run build:server`. Expected: PASS; it compiles.
- [ ] **Step 7:** Commit: `feat(server): config and IAP identity verification`.

### Task 4: Storage — interface, in-memory and Firestore implementations

**Files:**
- Create: `server/src/store/types.ts`, `server/src/store/memory.ts`, `server/src/store/firestore.ts`
- Test: `server/test/store.contract.ts` (shared suite), `server/test/store.memory.test.ts`, `server/test/store.firestore.test.ts` (runs only when `FIRESTORE_EMULATOR_HOST` is set, otherwise `describe.skip`)

**Interfaces:**
- **Produces** (`types.ts`):
  - **Linear token types:**
    - `interface LinearTokens { accessToken: string; refreshToken: string | null; expiresAt: number | null /* epoch ms */ }`
  - **History types** (snake_case to match today's frontend types):
    - `interface BaselineRow { issue_id: string; planned_start: string | null; planned_due: string }`
    - `interface Baseline extends BaselineRow { first_seen_at: string }`
    - `interface ChangeInput { projectId: string; issueId: string; field: string; oldValue: string | null; newValue: string | null }`
    - `interface ChangeEvent { issue_id: string; field_changed: string; old_value: string | null; new_value: string | null; changed_at: string }`
    - `interface TransitionInput { projectId: string; issueId: string; fromStatus: string | null; toStatus: string }`
  - **`interface Store`:**
    - `getTokens(sub: string): Promise<LinearTokens | null>`
    - `saveTokens(sub: string, email: string, tokens: LinearTokens): Promise<void>`
    - `clearTokens(sub: string): Promise<void>`
    - `swapTokens(sub: string, expectedRefreshToken: string, next: LinearTokens): Promise<LinearTokens>`. Inside a transaction: if the stored refresh token equals `expectedRefreshToken`, write `next` and return it; otherwise return what's stored (another request already renewed). If nothing is stored, return `next` without writing (the user disconnected meanwhile).
    - `listBaselines(sub: string, projectId: string): Promise<Baseline[]>`
    - `addBaselinesIfAbsent(sub: string, projectId: string, rows: BaselineRow[]): Promise<void>`. Rows that already exist keep their original values and `first_seen_at`.
    - `addChange(sub: string, change: ChangeInput): Promise<void>`
    - `listChanges(sub: string, issueId: string, limit: number): Promise<ChangeEvent[]>` (newest first)
    - `addTransition(sub: string, t: TransitionInput): Promise<void>`
- **Firestore layout:**
  - `users/{sub}`: `{ email, linear: LinearTokens | null, updatedAt }`
  - `users/{sub}/baselines/{issueId}`
  - `users/{sub}/issueChanges/{issueId}/events/{auto}`, keyed by issue so `orderBy('changed_at')` needs no composite index
  - `users/{sub}/transitions/{auto}`

- [ ] **Step 1:** Write the contract suite `runStoreContract(name, makeStore)`:
  - Tokens: save/get/clear round trip.
  - `swapTokens` with a matching refresh token writes and returns `next`.
  - `swapTokens` with a stale refresh token returns the stored (winner) tokens and doesn't overwrite.
  - `addBaselinesIfAbsent` twice with different dates keeps the first `planned_due`.
  - `listBaselines` filters by project.
  - `listChanges` returns newest first, respects `limit`, and only that issue's changes.
  - Data is isolated between two `sub`s.
- [ ] **Step 2:** Run `npx vitest run server/test/store.memory.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `memory.ts` (`createMemoryStore(): Store`) and `firestore.ts` (`createFirestoreStore(db: Firestore): Store`).
  - Firestore `swapTokens` uses `db.runTransaction`.
  - `addBaselinesIfAbsent` uses `create()` per doc, ignoring gRPC code 6 (ALREADY_EXISTS).
- [ ] **Step 4:** Run `npx vitest run server/test`. Expected: memory passes, Firestore is skipped.
  If the emulator is available (`gcloud emulators firestore start`), run with `FIRESTORE_EMULATOR_HOST` set and expect PASS. Otherwise note "Firestore contract not run against emulator" in the PR.
- [ ] **Step 5:** Commit: `feat(server): token and history storage (memory + Firestore)`.

### Task 5: Linear OAuth client and token service

**Files:**
- Create: `server/src/linear/oauth.ts`, `server/src/linear/tokens.ts`
- Test: `server/test/linear-oauth.test.ts`, `server/test/linear-tokens.test.ts`

**Interfaces:**
- **Consumes:** `Store` and `LinearTokens` (Task 4); `Config` (Task 3).
- **Produces** (`oauth.ts`):
  - `class LinearReauthRequired extends Error`
  - `interface LinearOAuth`:
    - `authorizeUrl(state: string): string`. Params: `client_id`, `redirect_uri`, `response_type=code`, `scope=read,write`, `state`.
    - `exchangeCode(code: string): Promise<LinearTokens>`
    - `refresh(refreshToken: string): Promise<LinearTokens>`. Throws `LinearReauthRequired` on HTTP 400 or 401.
    - `revoke(token: string): Promise<void>`. Best effort; never throws.
  - `createLinearOAuth(cfg: { clientId: string; clientSecret: string; redirectUri: string; fetch?: typeof fetch; now?: () => number }): LinearOAuth`. `expiresAt = now() + expires_in * 1000`; a missing `expires_in` gives `null`.
- **Produces** (`tokens.ts`):
  - `createTokenService(deps: { store: Store; oauth: LinearOAuth; now?: () => number }): { getAccessToken(sub: string, opts?: { forceRefresh?: boolean }): Promise<string> }`
  - It refreshes when `forceRefresh` is set or `expiresAt - now < 5 min`, then saves through `store.swapTokens`.
  - It throws `LinearReauthRequired` when there are no tokens or no refresh token, or when the refresh is rejected. In that case it calls `store.clearTokens` first.

- [ ] **Step 1:** Write failing tests with a stub `fetch`:
  - `exchangeCode` posts a form with `grant_type=authorization_code` and maps `expires_in: 86399` to `expiresAt`.
  - `refresh` posts `grant_type=refresh_token` and returns the rotated refresh token.
  - `refresh` on 400 throws `LinearReauthRequired`.
  - `revoke` posts the form field `token` and swallows a 400.
  - `getAccessToken`:
    - A fresh token → no fetch.
    - Expiring in 4 minutes → refreshes and stores the rotated tokens.
    - `forceRefresh` → refreshes.
    - Invalid grant → `LinearReauthRequired`, and the store is cleared.
    - **Concurrency (Review Focus 2):** two simultaneous `getAccessToken` calls on an expiring token, where the stub Linear accepts the same refresh token twice and returns different tokens. Both resolve to a valid access token; the store holds exactly one rotated set; neither throws.
- [ ] **Step 2:** Run `npx vitest run server/test/linear-*.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `oauth.ts` and `tokens.ts`.
- [ ] **Step 4:** Run the tests again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): Linear OAuth client with rotating refresh`.

### Task 6: HTTP app — middleware, Linear routes and GraphQL relay

**Files:**
- Create: `server/src/app.ts`, `server/src/routes/linear.ts`
- Test: `server/test/app.linear.test.ts`

**Interfaces:**
- **Consumes:** `Config`, `Identity`, `UnauthorizedError` (Task 3); `Store` (Task 4); `LinearOAuth`, `createTokenService`, `LinearReauthRequired` (Task 5).
- **Produces:**
  - `interface AppDeps { config: Config; identify: (req: Request) => Promise<Identity>; store: Store; oauth: LinearOAuth; fetch?: typeof fetch }`
  - `createApp(deps: AppDeps): Hono`
  - In Hono context, `c.get('identity')` returns `Identity`.
- **Middleware on `/api/*`:**
  - Identity: failure → `401 {error:'unauthorized'}`.
  - Origin check: on POST/PUT/PATCH/DELETE, the `Origin` header must equal `config.appOrigin`, otherwise `403 {error:'bad origin'}`.
- **Routes:**
  - `GET /api/me` → `{ email, linearConnected: boolean }`
  - `GET /api/linear/authorize`:
    - sets the cookie `linear_oauth_state` (32 random bytes hex; HttpOnly, Secure, SameSite=Lax, Path=/api/linear, Max-Age=600)
    - responds 302 to `oauth.authorizeUrl(state)`
  - `GET /api/linear/callback?code&state[&error]` responds 302 and clears the cookie in every case:
    - `error` present → `/app?linear_error=<error>`
    - state mismatch or missing → `/app?linear_error=invalid_state`
    - exchange failure → `/app?linear_error=exchange_failed`
    - success → `saveTokens(sub, email, tokens)`, then `/app`
  - `POST /api/linear/disconnect` → `oauth.revoke(accessToken)`, `store.clearTokens`, then `{ ok: true }`
  - `POST /api/linear/graphql` relays the body `{query, variables}` (limit 1 MB, else 413) to Linear with `Authorization: Bearer <token>`:
    - Returns Linear's status, JSON body and `retry-after` header unchanged.
    - On a Linear 401: get a token with `forceRefresh` and retry once. If it's still 401, `clearTokens`.
    - Not connected, or `LinearReauthRequired` → `401 { error: 'Linear authentication expired. Please reconnect.', reconnect: true }`.

- [ ] **Step 1:** Write failing tests using `app.request()`, with a stub `identify`, the memory store, a stub `oauth` and a stub `fetch`:
  - No identity → 401 on `/api/me`.
  - A POST with `Origin: https://evil.example` → 403.
  - A POST with no `Origin` → 403.
  - `/api/me` before and after `saveTokens`.
  - Authorize sets a cookie and returns a 302 to Linear.
  - Callback with a matching state saves tokens and redirects to `/app`.
  - Callback with a mismatched state → `/app?linear_error=invalid_state`, nothing saved.
  - **(Review Focus 5)** Callback with `error=access_denied` → `/app?linear_error=access_denied`.
  - The relay passes through 200 data, and 429 with `retry-after: 3`.
  - **(Review Focus 3)** Linear returns 401 twice → the response is 401 with `reconnect: true`, and `store.getTokens` is `null`.
  - Linear returns 401 then 200 → 200 after a forced refresh.
  - A body over 1 MB → 413.
  - Disconnect revokes and clears.
- [ ] **Step 2:** Run `npx vitest run server/test/app.linear.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `app.ts` (middleware plus mounting routes) and `routes/linear.ts`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): Linear OAuth routes and GraphQL relay behind IAP`.

### Task 7: History routes, static serving and the server entry point

**Files:**
- Create: `server/src/routes/history.ts`, `server/src/index.ts`
- Modify: `server/src/app.ts` (mount history; static + SPA fallback for non-`/api` paths)
- Test: `server/test/app.history.test.ts`

**Interfaces:**
- **Consumes:** `createApp`, `AppDeps` (Task 6); the `Store` history methods (Task 4).
- **Routes:**
  - `GET /api/history/baselines?projectId=` → `{ baselines: Baseline[] }` (400 if `projectId` is missing)
  - `POST /api/history/baselines` with `{ projectId, baselines: BaselineRow[] }` → `{ ok: true }`
  - `POST /api/history/changes` with `ChangeInput` → `{ ok: true }`
  - `GET /api/history/changes?issueId=` → `{ changes: ChangeEvent[] }` (limit 50)
  - `POST /api/history/transitions` with `TransitionInput` → `{ ok: true }`
  - Invalid bodies (wrong types or missing required strings) → 400.
- **Static serving:**
  - Files under `config.staticDir`.
  - `/assets/*` gets `Cache-Control: public, max-age=31536000, immutable`.
  - Any other non-`/api` GET with no matching file serves `index.html` with `Cache-Control: no-cache`.
  - Unknown `/api/*` → 404 JSON.
- **`index.ts`:**
  - `loadConfig(process.env)`.
  - `identify`:
    - `devUserEmail` set → `createDevIdentity`.
    - Otherwise → `createIapVerifier({ audience: iapAudience!, allowedDomain })`, reading the `x-goog-iap-jwt-assertion` header.
  - Store: `devUserEmail` → `createMemoryStore()`; otherwise `createFirestoreStore(new Firestore())`.
  - `createLinearOAuth(...)`, then `serve({ fetch: app.fetch, port })`.
  - Log one structured JSON line at startup: mode and port, no secrets.

- [ ] **Step 1:** Write failing tests:
  - Baselines round trip, where a second POST with different dates doesn't change the first.
  - Changes come back newest first and are limited to 50 when 51 are inserted.
  - A transition POST → 200.
  - Missing `projectId` → 400.
  - A body with `issueId: 5` → 400.
  - With a temp `staticDir` containing `index.html` and `assets/a.js`:
    - `/assets/a.js` → immutable cache header.
    - `/app` → the `index.html` contents.
    - `/api/nope` → 404 JSON.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `routes/history.ts`, the static serving in `app.ts`, and `index.ts`.
- [ ] **Step 4:** Run `npx vitest run server/test && npm run build:server`. Expected: all pass; it compiles.
- [ ] **Step 5:** Smoke-test locally.
  Run `DEV_USER_EMAIL=dev@bluecore.energy APP_ORIGIN=http://localhost:5173 LINEAR_CLIENT_ID=x LINEAR_CLIENT_SECRET=x LINEAR_REDIRECT_URI=http://localhost:5173/api/linear/callback npm run dev:server`, then `curl localhost:8080/api/me`.
  Expected: `{"email":"dev@bluecore.energy","linearConnected":false}`.
- [ ] **Step 6:** Commit: `feat(server): history API, static hosting and entry point`.

### Task 8: Frontend backend seam, with the Supabase implementation (behavior unchanged)

**Files:**
- Create:
  - `src/backend/types.ts`
  - `src/backend/supabase/index.ts`
  - `src/backend/supabase/useSupabaseAuth.ts` (moved from `src/hooks/useAuth.ts`, including U2)
  - `src/backend/supabase/history.ts`
  - `src/backend/supabase/LinearConnectSupabase.ts` (holds today's `handleConnect` logic as `connectLinear()`)
  - `src/backend/index.ts`: `export { backend } from '@/backend/impl'; export type * from './types';`
- Modify:
  - `vite.config.ts`: alias `@/backend/impl` → `src/backend/<VITE_BACKEND or 'supabase'>/index.ts`, read with `loadEnv(mode, process.cwd(), '')` (so a shell env var also works). Declare the alias *before* the general `@` alias.
  - `tsconfig.app.json`: add a `paths` entry `"@/backend/impl": ["./src/backend/supabase/index.ts"]` for type-checking.
  - `src/hooks/useAuth.ts` becomes `export const useAuth = () => backend.useAuth();`
  - `src/hooks/usePlanningHistory.ts` uses `backend.history.*` (same warn-and-continue error handling).
  - `src/api/linear.ts`: `gql` sends through `backend.linearRequest(apiKey, { query, variables })` instead of `fetch(LINEAR_API, …)`.
  - `src/components/LinearConnect.tsx` takes `onConnect: () => void` instead of reading `VITE_LINEAR_CLIENT_ID`.
  - `src/App.tsx` uses the `AuthState` fields.

**Interfaces** (`src/backend/types.ts`):
- **Produces:**
  - `interface AuthState`:
    - `user: { id: string; email: string } | null`
    - `loading: boolean`
    - `linearToken: string | null`. Opaque to callers; in GCP mode it is the literal `'server'` when connected.
    - `linearError: string | null`
    - `connectLinear(): void`
    - `refreshLinearToken(): Promise<string | null>`
    - `disconnectLinear(): Promise<void>`
    - `signOut(): Promise<void>`
    - `signIn?`, `signUp?`, `signInWithGoogle?`: present only when `capabilities.passwordLogin`; signatures as in `AuthPage` props.
  - `interface HistoryApi`:
    - `loadBaselines(projectId: string): Promise<TaskBaseline[]>`
    - `addBaselines(projectId: string, rows: Array<{ issue_id: string; planned_start: string | null; planned_due: string }>): Promise<void>`
    - `logChange(projectId: string, issueId: string, field: string, oldValue: string | null, newValue: string | null): Promise<void>`
    - `logStatusTransition(projectId: string, issueId: string, fromStatus: string | null, toStatus: string): Promise<void>`
    - `getTaskHistory(issueId: string): Promise<ChangeEvent[]>`
    - All of them throw on failure.
  - `interface Backend`:
    - `kind: 'supabase' | 'gcp'`
    - `capabilities: { sharing: boolean; passwordLogin: boolean; marketingPages: boolean }`
    - `useAuth(): AuthState`
    - `linearRequest(token: string, body: { query: string; variables?: Record<string, unknown> }): Promise<Response>`
    - `history: HistoryApi`
  - `TaskBaseline` and `ChangeEvent` move from `usePlanningHistory.ts` into `types.ts` and are re-exported from `usePlanningHistory.ts`.
  - The Supabase backend: `capabilities = { sharing: true, passwordLogin: true, marketingPages: true }`. `linearRequest` does today's fetch with `Authorization: token`.

- [ ] **Step 1:** Write `src/backend/supabase/history.test.ts`, mocking `@/lib/supabase` with `vi.mock`:
  - `addBaselines` calls `upsert` with `{ onConflict: 'user_id,issue_id', ignoreDuplicates: true }`.
  - `getTaskHistory` orders by `changed_at` descending with limit 50.
- [ ] **Step 2:** Run `npx vitest run src`. Expected: FAIL.
- [ ] **Step 3:** Create the seam and the Supabase implementation, then rewire the hooks and components listed above.
  `Callback.tsx`, `ShareDialog.tsx`, `useSharedData.ts` and `SharedView.tsx` keep importing `@/lib/supabase`; they're Supabase-only.
- [ ] **Step 4:** Run `npx vitest run src && npm run build && npm run lint`.
  Expected: pass, build OK, 0 lint errors. Then run `git diff --stat` and check that no Gantt component other than `LinearConnect` changed.
- [ ] **Step 5:** Commit: `refactor: route auth, history and Linear calls through a backend seam`.

### Task 9: GCP frontend implementation and capability gating

**Files:**
- Create: `src/backend/gcp/index.ts`, `src/backend/gcp/useGcpAuth.ts`, `src/backend/gcp/api.ts`
- Create: `src/components/SessionExpired.tsx`, a full-screen message "Your session expired. Reload to sign in again." with a Reload button.
- Modify:
  - `src/main.tsx`:
    - Register `/`, `/privacy-policy` and `/terms-of-service` (Landing etc.) only if `capabilities.marketingPages`; otherwise `/` renders `<Navigate to="/app" replace />`.
    - Register `/share/:shareToken` only if `capabilities.sharing`.
    - Register `/callback` only if `backend.kind === 'supabase'`.
  - `src/components/Header.tsx`: render the Share button only if `capabilities.sharing`, and load `ShareDialog` with `React.lazy`.
  - `src/App.tsx`: when `!user` → `capabilities.passwordLogin ? <AuthPage …/> : <SessionExpired />`. Show `linearError` on the `LinearConnect` screen.
  - `vite.config.ts`: `server.proxy['/api'] = 'http://localhost:8080'`.
  - `.env.example`: document `VITE_BACKEND`.

**Interfaces:**
- **Consumes:** the `Backend`, `AuthState` and `HistoryApi` types (Task 8); the server routes (Tasks 6 and 7).
- **Produces** (`api.ts`):
  - `class SessionExpiredError extends Error`
  - `apiFetch(path: string, init?: RequestInit): Promise<Response>`. It always uses `credentials: 'same-origin'` and `redirect: 'manual'`.
  - It throws `SessionExpiredError` when `res.type === 'opaqueredirect'`, on status 401 without `reconnect`, or when a network `TypeError` occurs. Other responses are returned unchanged.
- **GCP backend:**
  - `capabilities = { sharing: false, passwordLogin: false, marketingPages: false }`
  - `linearRequest` POSTs to `/api/linear/graphql` and ignores its token argument.
  - `history` maps to the `/api/history/*` routes.
  - `useGcpAuth`:
    - Loads `/api/me`. `SessionExpiredError` → `user: null`; success → `user: { id: email, email }`, `linearToken: linearConnected ? 'server' : null`.
    - `connectLinear()` sets `window.location.href = '/api/linear/authorize'`.
    - Reads `linear_error` from the URL into `linearError` (mapping `access_denied` → "Linear connection was cancelled."), then removes it with `history.replaceState`.
    - `refreshLinearToken()` re-fetches `/api/me` and returns `'server'` or `null`.
    - `disconnectLinear()` POSTs to `/api/linear/disconnect`.
    - `signOut()` navigates to `/?gcp-iap-mode=CLEAR_LOGIN_COOKIE`. Confirm this parameter in current IAP docs; if it's undocumented, hide "Sign out" by adding the capability flag `signOut: false`.

- [ ] **Step 1:** Write failing `src/backend/gcp/api.test.ts` with a stub global `fetch`:
  - **(Review Focus 1)** A response with `type: 'opaqueredirect'` → `SessionExpiredError`.
  - 401 `{error:'unauthorized'}` → `SessionExpiredError`.
  - 401 `{reconnect:true}` → returned unchanged, so `gql` reports "Linear authentication expired".
  - `fetch` rejects with `TypeError` → `SessionExpiredError`.
  - 200 → returned.
  - Requests use `redirect: 'manual'`.
- [ ] **Step 2:** Write failing `src/backend/gcp/linearError.test.ts` for the pure helper `readLinearError(search: string): string | null`:
  - **(Review Focus 5)** `?linear_error=access_denied` → "Linear connection was cancelled."
  - `?linear_error=invalid_state` → a "please try again" message.
  - None → `null`.
- [ ] **Step 3:** Run `npx vitest run src`. Expected: FAIL.
- [ ] **Step 4:** Implement the GCP backend, `SessionExpired` and the gating listed above.
- [ ] **Step 5:** Run `npx vitest run && VITE_BACKEND=gcp npm run build && npm run build && npm run lint`.
  Expected: everything passes. Then check the GCP bundle is free of Supabase:
  - Run `VITE_BACKEND=gcp npm run build && grep -rl "supabase.co\|functions/v1" dist/assets/*.js`.
  - Expected: no files outside lazily-loaded share/landing chunks, and the `index-*.js` entry chunk contains no `@supabase` code.
- [ ] **Step 6:** Do a local end-to-end check in dev mode:
  - Run `npm run dev:server` (env as in Task 7, plus a real dev Linear OAuth app with redirect `http://localhost:5173/api/linear/callback`, if Andrew provides credentials) and `VITE_BACKEND=gcp npm run dev`.
  - Connect Linear, load projects, drag a due date and a start date, cycle a status, add and remove a dependency, reload and confirm the ghost bars persist, then disconnect.
  - Without credentials, check only that the connect screen appears and that `/api/linear/authorize` redirects to linear.app. Record which checks ran in the PR.
- [ ] **Step 7:** Commit: `feat: GCP backend implementation and capability gating`.

### Task 10: Container, Cloud Build and setup guide

**Files:**
- Create:
  - `Dockerfile`:
    - Build stage on `node:22-slim`: `npm ci`, `VITE_BACKEND=gcp npm run build`, `npm run build:server`.
    - Runtime stage on `node:22-slim`: `npm ci --omit=dev`; copy `dist` and `server-dist`; set `NODE_ENV=production`, `PORT=8080`, `STATIC_DIR=dist`; run as user `node`; `CMD ["node","server-dist/index.js"]`.
  - `.dockerignore`: `node_modules`, `dist`, `server-dist`, `.env*`, `.git`, `.claude`, `supabase`.
  - `cloudbuild.yaml`:
    - Build and push `us-west2-docker.pkg.dev/$PROJECT_ID/ganttsmart/app:$SHORT_SHA`.
    - Then `gcloud run deploy ganttsmart --image … --region us-west2`. This updates the image only; env, secrets, ingress and service account are set once by the guide and kept across deploys.
  - `firestore.rules`: deny all.
  - `docs/gcp-deployment.md`: the Cloud Shell guide covering every step in spec §7, with copy-paste commands using `PROJECT_ID`/`PROJECT_NUMBER` variables. It includes:
    - **Service account:** create `ganttsmart-run` with `roles/datastore.user`, plus `roles/secretmanager.secretAccessor` on secret `linear-client-secret`.
    - **First deploy flags:** `--service-account`, `--ingress internal-and-cloud-load-balancing`, `--set-secrets LINEAR_CLIENT_SECRET=linear-client-secret:latest`, and `--set-env-vars APP_ORIGIN,ALLOWED_EMAIL_DOMAIN,LINEAR_CLIENT_ID,LINEAR_REDIRECT_URI,IAP_AUDIENCE`.
    - **Load balancer:** static IP, serverless NEG, backend service, URL map, HTTPS proxy, managed certificate for `ganttsmart.bluecore.energy`, forwarding rule, and an HTTP→HTTPS redirect.
    - **IAP:** internal consent screen, `gcloud iap web enable` on the backend service, and grant `domain:bluecore.energy` `roles/iap.httpsResourceAccessor`.
    - **IAP audience:** set `IAP_AUDIENCE=/projects/PROJECT_NUMBER/global/backendServices/BACKEND_SERVICE_ID` and redeploy.
    - **Cloud Run invoker setup** for the load-balancer + IAP pattern, verified against current Google docs at writing time.
    - **DNS:** an A record `ganttsmart` → the static IP.
    - **Cloud Build:** trigger on `main` of `Blue-Core-Energy/ganttsmart`.
    - **Verification checklist:** non-Bluecore account refused; `.run.app` URL refused; connect, edit and reload works; secret rotation.
- Modify: `README.md`, adding a short "Self-hosting on Google Cloud" section linking the guide and describing `VITE_BACKEND`.

- [ ] **Step 1:** Build the container: `podman build -t ganttsmart:test .`. Expected: success.
- [ ] **Step 2:** Run the container smoke test:
  - Start `podman run --rm -p 8080:8080 -e NODE_ENV=development -e DEV_USER_EMAIL=dev@bluecore.energy -e APP_ORIGIN=http://localhost:8080 -e LINEAR_CLIENT_ID=x -e LINEAR_CLIENT_SECRET=x -e LINEAR_REDIRECT_URI=http://localhost:8080/api/linear/callback ganttsmart:test`.
  - `curl -s localhost:8080/api/me` → dev user JSON.
  - `curl -s localhost:8080/app` → HTML containing `<div id="root">`.
- [ ] **Step 3:** Production guard: `podman run --rm -e DEV_USER_EMAIL=x@bluecore.energy … ganttsmart:test` (with `NODE_ENV=production`, the image default). Expected: exits non-zero, logging that `DEV_USER_EMAIL` isn't allowed in production.
- [ ] **Step 4:** Proofread the guide against spec §5 and §7. Every value (region, names, domain, redirect URI, roles) must match the Global Constraints.
- [ ] **Step 5:** Commit: `feat: container, Cloud Build config and GCP deployment guide`.
- [ ] **Step 6:** Push `feat/gcp-backend` and open a draft PR into the fork's `main`.
  The body notes that it's stacked on the U2 PR, summarizes the work, lists the manual checks run and not run, and links the guide.
