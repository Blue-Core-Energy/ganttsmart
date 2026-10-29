# GanttSmart on Google Cloud — Design

**Date:** 2026-10-29
**Owner:** Andrew (Bluecore Energy)
**Repo:** fork at `github.com/Blue-Core-Energy/ganttsmart` (`origin`); original at `github.com/sideq-io/ganttsmart` (`upstream`)

## 1. Intent

Bluecore tracks all work — engineering and non-engineering — in Linear, but schedules in Smartsheet, so work is tracked in two places. Linear has nearly everything needed to replace Smartsheet except issue-level scheduling. GanttSmart fills that gap: it adds issue start dates (stored in the issue description as `start: DD-MM-YY`), and together with due dates and blocks/blocked-by relations, Linear issues become a schedule. Its Gantt view lets people see timelines, durations and dependencies — more than Linear's milestone view.

GanttSmart is an extension of Linear that works on the same data alongside it. Issues are created and managed in Linear; GanttSmart is used only for scheduling. Most of the company will use it: mostly leads editing schedules, plus occasional edits from others and a lot of reading the schedule.

This project makes GanttSmart available to the whole company at `https://ganttsmart.bluecore.energy`, only to people with a `@bluecore.energy` Google account, using only Google Cloud (plus Linear). Bluecore does not use Supabase and wants to keep the number of vendors to a minimum. GCP credits pay for hosting.

**Success:** Bluecore staff open the URL, are already signed in through Google, connect Linear once, and from then on can view and edit schedules with no further setup — and Smartsheet is no longer needed for scheduling.

## 2. Goals

1. **Add a Google Cloud backend as a build-time option alongside the existing Supabase backend**, so the fork can still be merged back upstream. The existing Supabase setup must keep working.
2. **Make the app reachable only by `@bluecore.energy` Google accounts**, enforced by Identity-Aware Proxy (IAP) in front of every request: page, assets, API and OAuth callback.
3. **Use a single sign-in.** In the GCP setup, IAP's Google login is the only login; the app has no login screen of its own.
4. **Each person connects their own Linear account once.** Edits are made as that person, under their Linear permissions.
5. **Keep Linear tokens off the browser** in the GCP setup. The server holds them and relays Linear GraphQL calls.
6. **Renew Linear tokens automatically.** Linear access tokens expire after 24 hours and must be renewed with a rotating refresh token; this applies to all Linear OAuth apps since April 1, 2026. Users should never have to reconnect just because a day has passed.
7. **Keep the planning-history features** (baseline "ghost bars", change log, status transitions) **per person, exactly as today.** Each person's baseline is their own first view.
8. **Deploy automatically** from the fork's `main` branch, with a step-by-step setup guide that can be followed entirely in Cloud Shell. No one should need to run anything locally.

### Upstream-friendly fixes (shipped as separate small PRs)

Separately from the GCP option, two bugs in the existing Supabase setup get fixed as standalone PRs, so they can be offered upstream on their own:

- **U1 — Remove the `anon_read` policy on `shared_roadmaps`.** It lets anyone holding the public anon key read every shared roadmap, including cached Linear data and password hashes. *Done on branch `fix/shared-roadmaps-anon-read` (migration 007); needs review.*
- **U2 — Linear token refresh for the Supabase setup.** Today only the access token is stored and it is never refreshed, so it stops working after 24 hours. *Work in progress on branch `fix/linear-token-refresh` (WIP commit, paused for this spec).*

## 3. Non-goals

- **Cross-project dependency view.** This is a separate future project; today arrows only appear when both issues are in the loaded project.
- **Shared, company-wide baselines** (explicitly declined: baselines stay per person).
- **Share links in the GCP setup.** They are hidden or disabled there and stay available in the Supabase setup.
- **Uptime monitoring and alerts.** A "the site is down" notification is wanted later, but is not part of this project. The design must not prevent adding it (see §9).
- Budget alerts and backups of history data.
- Moving any existing Supabase data (Bluecore has none).
- Changing how start dates are stored (the description tag stays).
- Supporting multiple Linear workspaces, or users outside Bluecore.
- Restyling or reworking the Gantt UI.

## 4. Anti-goals (failure even if it "works")

- Any page, API route or OAuth callback reachable without a `@bluecore.energy` Google login.
- Linear access or refresh tokens, or the Linear client secret, reaching the browser in the GCP setup.
- Breaking the existing Supabase setup, or making it require GCP configuration.
- A sprawling diff through the Gantt components that makes upstream merging hopeless. Backend-specific code should stay behind a narrow seam.
- Vendors beyond Google Cloud and Linear in the GCP setup.

## 5. Constraints and decided choices

| Topic | Decision | Source |
|---|---|---|
| Cloud | Google Cloud only; GCP credits | Andrew |
| GCP organization | `bluecore.energy` organization exists (verified) | Andrew |
| URL | `https://ganttsmart.bluecore.energy` (subdomain, not a sub-path) | Andrew |
| Custom domain + IAP | Global external Application Load Balancer + serverless NEG + Google-managed certificate, with IAP on the backend service. (Cloud Run domain mappings are preview / not production-ready; Firebase Hosting can't pass IAP identity.) | Agreed |
| Access | `domain:bluecore.energy` gets *IAP-secured Web App User*; can be narrowed to a Google Group later without code changes | My call |
| IAP consent screen | Internal (organization-only) | Agreed |
| Region | `us-west2` (Los Angeles; Bluecore is in Long Beach) for Cloud Run, Artifact Registry and Firestore | My call |
| Backend selection | Build-time setting, e.g. `VITE_BACKEND=supabase|gcp`, defaulting to `supabase` so upstream behavior is unchanged | Agreed |
| Linear OAuth app | Created in Bluecore's Linear workspace (private), scopes `read,write`, `actor=user` (the default) | Agreed |
| Linear tokens | 24h access token, rotating refresh token, 30-minute grace period for reusing the previous refresh token; revoke via `POST https://api.linear.app/oauth/revoke` with a `token` field (verified against Linear docs, 2026-10-29) | Verified |
| History data | Per person, same behavior as today | Andrew |
| Share links | Off in the GCP setup | Andrew |
| Deploys | Cloud Build trigger on push to `main` of the fork | Agreed |
| Git | Fork is `origin`, sideq-io is `upstream`; work goes to feature branches and PRs into the fork's `main` | Agreed |
| License | AGPL-3.0; the modified source stays available to users (the fork satisfies this) | Noted |

## 6. Architecture (GCP setup)

```
Browser ─HTTPS─► Global external ALB (managed cert for ganttsmart.bluecore.energy)
                    └─ backend service (IAP enabled, internal consent screen)
                         └─ serverless NEG ─► Cloud Run service "ganttsmart" (us-west2)
                                               ├─ static React build (SPA fallback)
                                               └─ /api/* (Node + TypeScript)
                                                    ├─ Firestore (Native, us-west2)
                                                    ├─ Secret Manager: LINEAR_CLIENT_SECRET
                                                    └─ api.linear.app (OAuth + GraphQL)
```

- **One container** serves both the built frontend and the API, so all traffic is same-origin and behind IAP.
- **Cloud Run ingress** is `internal-and-cloud-load-balancing`, so the `*.run.app` URL can't be used to get around IAP. Whatever Cloud Run invoker setup the load-balancer + IAP pattern needs, per current Google docs, is used.
- **A dedicated runtime service account** gets only Firestore read/write (`roles/datastore.user`) and access to the one secret (`roles/secretmanager.secretAccessor`).

### 6.1 Server responsibilities

1. **Identity.**
   - Verify the `x-goog-iap-jwt-assertion` header on every `/api/*` request: check the signature against Google's IAP public keys, the issuer `https://cloud.google.com/iap`, and the audience, which comes from config (e.g. `IAP_AUDIENCE`).
   - Reject requests where the email doesn't end in the allowed domain (config, e.g. `ALLOWED_EMAIL_DOMAIN=bluecore.energy`).
   - Identify users by the stable IAP subject (`sub`) and store their email alongside. *(My call: emails can change; the subject doesn't.)*
   - Static asset requests are protected by IAP itself and need no app-level check.
2. **Cross-site request protection.** Reject state-changing requests (POST/PUT/DELETE) whose `Origin` header isn't the app's own origin. *(My call: IAP authenticates with a cookie, so CSRF protection is still needed.)*
3. **Linear OAuth flow, server-side.**
   - `GET /api/linear/authorize` creates a random `state`, stores it in a short-lived, HttpOnly, Secure, SameSite=Lax cookie, and redirects to `https://linear.app/oauth/authorize`.
   - `GET /api/linear/callback` checks `state`, exchanges the code using the client secret from Secret Manager, saves the tokens, and redirects to `/app`.
   - On failure it redirects to `/app` with an error the UI can show.
   - Linear redirect URI: `https://ganttsmart.bluecore.energy/api/linear/callback`.
4. **Token storage and renewal.**
   - Store the access token, refresh token and expiry per user.
   - Renew the token shortly before it expires, or when Linear returns a 401, then retry once.
   - Save the rotated refresh token inside a Firestore transaction, so concurrent requests or instances don't overwrite each other; Linear's 30-minute grace period covers races.
   - If renewal is rejected (invalid or revoked grant), delete the stored tokens and respond so the UI shows "Reconnect Linear."
5. **GraphQL relay.**
   - `POST /api/linear/graphql` forwards `{query, variables}` to `https://api.linear.app/graphql` with the user's token.
   - Pass through Linear's status, `retry-after` on 429, and the JSON body, so the existing client retry logic keeps working.
   - Limit the request body size.
   - Don't restrict which queries are allowed: users can only do what their own Linear token allows.
6. **Disconnect.** `POST /api/linear/disconnect` revokes the token at Linear (best effort) and deletes the stored tokens.
7. **Session info.** `GET /api/me` returns `{ email, linearConnected }`.
8. **History endpoints**, replacing direct Supabase table access with the same meaning:
   - **Baselines:** list for a project; insert-if-absent for a batch. The first-seen dates win, as today's `ignoreDuplicates` upsert does.
   - **Change log:** append; list for an issue (newest first, limit 50).
   - **Status transitions:** append.
9. **Static files.** Serve the Vite build with SPA fallback to `index.html` for non-`/api` paths, using sensible cache headers (hashed assets cached long, `index.html` not cached).

### 6.2 Firestore data (Native mode)

Per user, keyed by IAP subject:

- `users/{sub}`
  - `email`
  - Linear access token, refresh token, token expiry
  - `connectedAt`, `updatedAt`
- `users/{sub}/baselines/{issueId}`
  - `projectId`, `plannedStart`, `plannedDue`, `firstSeenAt`
- `users/{sub}/changes/{auto}`
  - `issueId`, `projectId`, `field`, `oldValue`, `newValue`, `changedAt`
- `users/{sub}/transitions/{auto}`
  - `issueId`, `projectId`, `fromStatus`, `toStatus`, `transitionedAt`

Firestore security rules deny all client access; only the server's service account (through IAM) reads and writes. Field names and exact shapes are left to the builder.

### 6.3 Frontend

- **A narrow backend seam** (e.g. `src/backend/`) with two implementations: `supabase` (today's behavior, plus U2 token renewal) and `gcp` (calls `/api/*`). It covers:
  - session and current user
  - Linear connection status, connect, disconnect and token renewal
  - sending a Linear GraphQL request
  - the planning-history operations
  - capability flags for share links and the in-app login screen

  App and hook code uses this seam instead of importing Supabase directly. The exact interface is left to the builder.
- **`src/api/linear.ts`** keeps its queries, rate limiting and retries, but sends requests through the seam. In GCP mode, the `linearToken` value passed around the components is not a real credential. How that's represented is left to the builder, with the smallest reasonable diff to components.
- **In GCP mode:**
  - **No login screen.** IAP has already authenticated the user; if `/api/me` fails with 401, show a "session expired, reload" message.
  - **"Connect Linear"** links to `/api/linear/authorize`.
  - **The share button and `/share/:token` route are hidden.**
  - **`/` opens the app.** The marketing landing page and ganttsmart.com privacy and terms pages aren't shown.
  - **"Sign out":** use IAP's documented sign-out mechanism if there is one; otherwise hide it.
- **The GCP build must not require or contact Supabase.** Supabase env vars must not be needed, and the Supabase client must not be created. Leaving the Supabase library out of the GCP bundle is preferred but not required.
- **The Supabase build behaves exactly as today**, plus U1 and U2.

### 6.4 Local development (GCP mode)

A dev-only identity bypass sets a fake user (e.g. `DEV_USER_EMAIL`), and the server refuses to start with it in production. Local storage uses an in-memory store or the Firestore emulator (builder's call; in-memory is preferred so no extra tools are needed). Vite's dev server proxies `/api` to the local server.

## 7. Deployment artifacts

- **`Dockerfile`:** a multi-stage build of the frontend (`VITE_BACKEND=gcp`) and the server into one Node runtime image.
- **`cloudbuild.yaml`:** build, push to Artifact Registry (`us-west2`), and deploy to Cloud Run with the runtime service account, the secret reference, env config and ingress setting.
- **Setup guide** (e.g. `docs/gcp-deployment.md`), written for Cloud Shell, step by step:
  1. Create the project in the `bluecore.energy` org and link billing to the credits.
  2. Enable the APIs.
  3. Set up Firestore in Native mode (`us-west2`) with deny-all security rules.
  4. Create the service account and grant its roles.
  5. Create the Linear OAuth app with the redirect URI, then store the secret in Secret Manager.
  6. Connect Cloud Build to the fork and add a trigger on `main`.
  7. Do the first deploy.
  8. Set up the load balancer: serverless NEG, backend service, URL map, managed certificate, static IP.
  9. Configure IAP: internal consent screen, enable it on the backend service, grant `domain:bluecore.energy`.
  10. Add a DNS A record for `ganttsmart` at Bluecore's DNS provider.
  11. Verify: a non-Bluecore account is refused; the `.run.app` URL is refused; the connect, edit and reload flow works.
  12. Rotate the Linear secret if needed.
- **`.env.example` / README:** document both setups and the backend setting.

## 8. Testing

- **Server automated tests** (e.g. Vitest):
  - IAP JWT check: valid; bad signature; wrong audience; expired; wrong domain; missing header.
  - Origin check on state-changing requests.
  - OAuth `state` check.
  - Token renewal: happy path; refresh when expiring; 401-then-refresh-then-retry; invalid grant clears tokens; rotation is saved.
  - GraphQL relay passing through status and `retry-after`.
  - History endpoints: insert-if-absent keeps first-seen values; change log order and limit.
  - Linear is mocked; tests never call real Linear or GCP.
- **Both setups must pass** `tsc` and lint (no new errors) and must build. The Supabase build must still work without GCP config.
- **Local manual check** in GCP mode with the dev identity and a real Linear OAuth app (dev redirect URI): connect, load projects, drag a due date and start date, cycle a status, add and remove a dependency, check ghost bars persist, disconnect.
- **After deployment**, the checks in step 11 of the setup guide.

## 9. Future work (designed to be possible, not built now)

- **Downtime notification.** Cloud Monitoring can watch Cloud Run and load balancer metrics (5xx rate, no successful requests) and alert by email. Uptime checks against IAP-protected URLs need extra setup; an unauthenticated `/healthz` path excluded from IAP is *not* allowed under the anti-goals unless it reveals nothing. To decide when picked up.
- Cross-project dependency view (separate spec).
- Opening an upstream issue proposing the self-hosted GCP option before the large PR (recommended).

## 10. Left to the builder

- Server framework (e.g. Hono or Express), file layout, and the Node version (Cloud Run-supported LTS).
- The exact backend-seam interface and how `linearToken` is represented in GCP mode.
- Firestore field names, and how the transaction for renewal is structured.
- Cookie names, error formats, and logging (structured JSON to stdout for Cloud Logging).
- Whether U2's WIP is kept as written or reworked, as long as the refresh token is never readable by the browser.
- PR breakdown and order beyond: U1 and U2 as separate small PRs, and the GCP option as its own PR.
