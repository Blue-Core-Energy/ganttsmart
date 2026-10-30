# Deploying GanttSmart on Google Cloud

This guide sets up GanttSmart at **https://ganttsmart.bluecore.energy**, open only to `@bluecore.energy` Google accounts. Every step runs in **Google Cloud Shell** (the terminal built into the Google Cloud console), so nothing needs installing on your own computer.

Plan for about two hours, most of it waiting for the HTTPS certificate. Work through the steps in order. Each one says what it does, gives commands to copy and paste, and ends with a **Check** you should see pass before moving on.

## How it fits together

```
Browser ─HTTPS─► Load balancer (static IP, Google-managed certificate for ganttsmart.bluecore.energy)
                    └─ backend service "ganttsmart-backend"  ◄── IAP: only @bluecore.energy accounts get past here
                         └─ serverless NEG ─► Cloud Run service "ganttsmart" (us-west2)
                                               ├─ the React app
                                               └─ /api/* ─► Firestore, Secret Manager, api.linear.app
```

- **Identity-Aware Proxy (IAP)** signs people in with Google and turns away anyone outside `bluecore.energy` before a request reaches the app. The app then checks IAP's signed header on every API call.
- **Cloud Run** runs one container that serves both the web app and the API. It only accepts traffic that comes through the load balancer and has been let through by IAP, so its own `*.run.app` address can't be used to get around sign-in.
- **Firestore** stores each person's Linear connection and planning history. **Secret Manager** holds the Linear client secret.
- **Cloud Build** rebuilds and redeploys automatically whenever `main` changes in `Blue-Core-Energy/ganttsmart`.

## What you need before starting

- A `@bluecore.energy` Google account that can create projects in the `bluecore.energy` organization and link them to the billing account that holds the Google Cloud credits.
- Admin access to Bluecore's Linear workspace, to create an OAuth application.
- Access to Bluecore's DNS provider for `bluecore.energy`, to add one record.
- A second Google account that is **not** `@bluecore.energy` (a personal Gmail is fine), to test that outsiders are refused.
- All the Google Cloud pull requests merged into `main` of `Blue-Core-Energy/ganttsmart`, including the one that added this guide. Steps 6 and 7 build the code from `main`, so anything not merged yet won't be deployed.

## Names used in this guide

| Thing | Name |
|---|---|
| Region (Cloud Run, Artifact Registry, Firestore, Cloud Build) | `us-west2` |
| Cloud Run service | `ganttsmart` |
| Runtime service account (what the app runs as) | `ganttsmart-run` |
| Build service account (what Cloud Build runs as) | `ganttsmart-build` |
| Artifact Registry repository | `ganttsmart` (images are `…/ganttsmart/app:<tag>`) |
| Secret Manager secret | `linear-client-secret` |
| Load balancer pieces | `ganttsmart-ip`, `ganttsmart-neg`, `ganttsmart-backend`, `ganttsmart-urlmap`, `ganttsmart-cert`, `ganttsmart-https-proxy`, `ganttsmart-https-rule`, `ganttsmart-http-redirect`, `ganttsmart-http-proxy`, `ganttsmart-http-rule` |
| Linear redirect URI | `https://ganttsmart.bluecore.energy/api/linear/callback` |

The app's settings, which the steps below set on the Cloud Run service:

| Variable | Value | Notes |
|---|---|---|
| `APP_ORIGIN` | `https://ganttsmart.bluecore.energy` | Used to reject cross-site form posts |
| `ALLOWED_EMAIL_DOMAIN` | `bluecore.energy` | A second check after IAP |
| `LINEAR_CLIENT_ID` | from the Linear OAuth app (step 5) | Not secret |
| `LINEAR_CLIENT_SECRET` | from Secret Manager `linear-client-secret` | Never typed into a config file |
| `LINEAR_REDIRECT_URI` | `https://ganttsmart.bluecore.energy/api/linear/callback` | Must match the Linear app exactly |
| `IAP_AUDIENCE` | `/projects/PROJECT_NUMBER/global/backendServices/BACKEND_SERVICE_ID` | Set for real in step 10 |
| `NODE_ENV`, `PORT`, `STATIC_DIR` | `production`, `8080`, `dist` | Already built into the image |

`DEV_USER_EMAIL` is for local development only. The server refuses to start if it is set in production or on Cloud Run, so never add it here.

---

## Step 0: Open Cloud Shell and set your variables

**What this does:** opens a terminal and saves the names used by every later command in a small file, so you can reload them if Cloud Shell disconnects.

1. Go to <https://console.cloud.google.com>, signed in with your `@bluecore.energy` account.
2. Click the **Activate Cloud Shell** button (the `>_` icon, top right). A terminal opens at the bottom of the page.
3. Choose a project ID. It must be unique across all of Google Cloud, 6-30 characters, lowercase letters, digits and hyphens. The commands below use `bluecore-ganttsmart`; change it in the first line if that's taken.
4. Paste this block. It writes `~/ganttsmart-vars.sh` and loads it:

```bash
cat > ~/ganttsmart-vars.sh <<'EOF'
export PROJECT_ID=bluecore-ganttsmart
export REGION=us-west2
export DOMAIN=ganttsmart.bluecore.energy
export SERVICE=ganttsmart
export RUN_SA=ganttsmart-run@${PROJECT_ID}.iam.gserviceaccount.com
export BUILD_SA=ganttsmart-build@${PROJECT_ID}.iam.gserviceaccount.com
export IMAGE=${REGION}-docker.pkg.dev/${PROJECT_ID}/ganttsmart/app
# Filled in by later steps (step 1 and step 5):
export PROJECT_NUMBER=
export LINEAR_CLIENT_ID=
EOF
source ~/ganttsmart-vars.sh
```

**If Cloud Shell disconnects or you open a new tab,** run `source ~/ganttsmart-vars.sh` before continuing. Steps 1 and 5 tell you how to fill in the two empty values.

**Pasting commands:** paste one command (or one small group) at a time and read the output before moving on. Some commands stop to ask a question (for example "API not enabled, enable it? (y/N)"); if you pasted several lines at once, the next pasted line is taken as the answer and both commands are lost, and errors are easy to miss in a long scroll. If a command fails, fix it and re-run just that command.

**Check:** `echo $PROJECT_ID $REGION $DOMAIN` prints your three values.

---

## Step 1: Create the project and link billing

**What this does:** creates the Google Cloud project inside the `bluecore.energy` organization and pays for it from the credits' billing account.

```bash
gcloud organizations list
```

Note the `ID` of `bluecore.energy`, then (replacing `ORG_ID`):

```bash
gcloud projects create $PROJECT_ID --organization=ORG_ID --name="GanttSmart"
gcloud config set project $PROJECT_ID
gcloud billing accounts list
```

Note the `ACCOUNT_ID` of the billing account with the credits, then (replacing `BILLING_ACCOUNT_ID`):

```bash
gcloud billing projects link $PROJECT_ID --billing-account=BILLING_ACCOUNT_ID
```

Save the project number into your variables file:

```bash
sed -i "s/^export PROJECT_NUMBER=.*/export PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')/" ~/ganttsmart-vars.sh
source ~/ganttsmart-vars.sh
echo $PROJECT_NUMBER
```

**Check:** `gcloud billing projects describe $PROJECT_ID` shows `billingEnabled: true`, and `echo $PROJECT_NUMBER` prints a long number.

---

## Step 2: Enable the APIs

**What this does:** switches on the Google Cloud services the app uses. It takes a minute or two.

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  compute.googleapis.com \
  iap.googleapis.com \
  iam.googleapis.com
```

If it asks a question, answer `y`. If it prints an error, fix it and run it again; it's safe to re-run.

**Check:** `gcloud services list --enabled` includes all eight. If one is missing, enable it on its own, e.g. `gcloud services enable firestore.googleapis.com`.

---

## Step 3: Create the Firestore database

**What this does:** creates the database (Native mode, in `us-west2`) and locks it so that no browser or phone can read or write it directly. Only the app's service account can, through IAM.

```bash
gcloud firestore databases create --database='(default)' --location=$REGION --type=firestore-native --edition=standard
```

The location can't be changed later. If `--edition` is rejected by your `gcloud` version, run the same command without `--edition=standard` (Standard is the default).

If it says the Firestore API isn't enabled (or the console asks you to enable Firestore), enable it with `gcloud services enable firestore.googleapis.com` (or the console's **Enable** button), wait a minute, and run the create command again.

**Security rules: check them, you normally don't need to edit them.** The app needs Firestore locked to everything except its own service account. That's what the rules in [`firestore.rules`](../firestore.rules) say (`allow read, write: if false;` for everything), and a newly created database normally already has exactly these locked rules. The server isn't affected by security rules; they only stop browsers and phones from reaching the database directly.

1. Open <https://console.cloud.google.com/firestore/databases> (project `bluecore-ganttsmart` or yours) and click **(default)**. *Verify in console:* menu names can differ slightly.
2. Open the rules view (labelled **Security rules** or **Rules**).
3. If it shows `allow read, write: if false;` for `match /{document=**}`, you're done. Nothing to change.
4. Only if it shows something else (for example `allow read, write: if true;`, or a rule with a date such as `request.time < timestamp.date(...)`): click into the editor, replace everything with the contents of `firestore.rules` below, and click **Publish**. If you can't find how to edit it, stop and ask for help. Don't continue with open rules.

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if false;
       }
     }
   }
   ```

**Check:**

- `gcloud firestore databases describe --database='(default)' --format='value(locationId,type)'` prints `us-west2 FIRESTORE_NATIVE`.
- The rules view shows `allow read, write: if false;`.

---

## Step 4: Create the image repository and service accounts

**What this does:** creates the Artifact Registry repository that holds the app's container images, the account the app runs as (with only the access it needs), and the account Cloud Build runs as.

```bash
# Container image repository
gcloud artifacts repositories create ganttsmart \
  --repository-format=docker --location=$REGION --description="GanttSmart images"

# Runtime service account: Firestore read/write only. Secret access is granted on the one secret in step 5.
gcloud iam service-accounts create ganttsmart-run --display-name="GanttSmart Cloud Run runtime"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:$RUN_SA --role=roles/datastore.user

# Build service account: push images, deploy new revisions, write build logs
gcloud iam service-accounts create ganttsmart-build --display-name="GanttSmart Cloud Build"
gcloud artifacts repositories add-iam-policy-binding ganttsmart --location=$REGION \
  --member=serviceAccount:$BUILD_SA --role=roles/artifactregistry.writer
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:$BUILD_SA --role=roles/run.developer
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:$BUILD_SA --role=roles/logging.logWriter
# Lets Cloud Build deploy a service that runs as ganttsmart-run
gcloud iam service-accounts add-iam-policy-binding $RUN_SA \
  --member=serviceAccount:$BUILD_SA --role=roles/iam.serviceAccountUser
```

Run the repository command first and confirm it prints `Created repository [ganttsmart]` before running the rest.

If `add-iam-policy-binding` asks about a condition, choose `None`.

**If you run this step again,** `ALREADY_EXISTS` / "already exists" errors for the repository or service accounts are fine. Those were created the first time.

**If `artifacts repositories add-iam-policy-binding` says `PERMISSION_DENIED`,** first check that the repository exists: `gcloud artifacts repositories describe ganttsmart --location=$REGION`. Artifact Registry reports a missing repository as "permission denied". If `describe` says `NOT_FOUND`, run the `repositories create` command again on its own, then the binding. If the repository does exist, your account lacks permission to change it; you need the **Owner** role on the project.

**If a binding says the service account doesn't exist** right after you created it, wait a minute and run that command again. New accounts take a moment to appear everywhere.

Why a separate build account: Google recommends running builds as your own service account with only the roles they need, instead of a broad default account ([Cloud Build default service account](https://cloud.google.com/build/docs/cloud-build-service-account), [user-specified service accounts](https://cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts)).

**Check:**

```bash
gcloud artifacts repositories list --location=$REGION
gcloud iam service-accounts list
gcloud projects get-iam-policy $PROJECT_ID --flatten=bindings --filter="bindings.members:ganttsmart-" --format="table(bindings.role,bindings.members)"
gcloud artifacts repositories get-iam-policy ganttsmart --location=$REGION
gcloud iam service-accounts get-iam-policy $RUN_SA
```

You should see:

- The `ganttsmart` repository.
- Both service accounts. Google's default compute account, and a `firebase-adminsdk` account if the project is linked to Firebase, may also be listed. Leave those alone.
- `roles/datastore.user` for `ganttsmart-run`, and `roles/run.developer` plus `roles/logging.logWriter` for `ganttsmart-build`.
- `ganttsmart-build` under `roles/artifactregistry.writer` on the repository.
- `ganttsmart-build` under `roles/iam.serviceAccountUser` on `ganttsmart-run`.

If any of these are missing, re-run just that command from above. The last two are only needed for automatic deploys in step 11, but a missing one fails there in a way that's hard to trace back here.

---

## Step 5: Create the Linear OAuth app and store its secret

**What this does:** registers GanttSmart with Bluecore's Linear workspace so people can connect their Linear accounts, then stores the client secret in Secret Manager where only the app can read it.

### 5a. In Linear

1. In Linear, open **Settings → API → OAuth applications** (<https://linear.app/settings/api/applications>) in Bluecore's workspace and create a new application.
2. Fill in:
   - **Name:** `GanttSmart (Bluecore)`
   - **Developer name / URL:** `Bluecore Energy` / `https://ganttsmart.bluecore.energy`
   - **Callback URLs:** `https://ganttsmart.bluecore.energy/api/linear/callback` (exactly this, nothing else)
   - Leave it **private** to the workspace (not public).
3. Save. Linear shows a **Client ID** and **Client secret**. Keep the page open.

The app asks for scopes `read,write` and acts as the signed-in user (`actor=user`, Linear's default) each time someone connects; those aren't settings on the Linear app itself ([Linear OAuth docs](https://linear.app/developers/oauth-2-0-authentication)).

### 5b. In Cloud Shell

Save the client ID (it isn't secret), replacing `PASTE_CLIENT_ID`:

```bash
sed -i "s/^export LINEAR_CLIENT_ID=.*/export LINEAR_CLIENT_ID=PASTE_CLIENT_ID/" ~/ganttsmart-vars.sh
source ~/ganttsmart-vars.sh
```

Store the client secret. `read -rs` asks for it without showing it on screen or saving it in your shell history:

```bash
read -rs -p "Linear client secret: " LINEAR_SECRET && echo
printf '%s' "$LINEAR_SECRET" | gcloud secrets create linear-client-secret --replication-policy=automatic --data-file=-
unset LINEAR_SECRET

# Only the runtime service account may read it
gcloud secrets add-iam-policy-binding linear-client-secret \
  --member=serviceAccount:$RUN_SA --role=roles/secretmanager.secretAccessor
```

Never put the secret in `cloudbuild.yaml`, the `Dockerfile`, a `.env` file or anywhere in the repo.

**Check:**

```bash
echo $LINEAR_CLIENT_ID
gcloud secrets versions list linear-client-secret
gcloud secrets get-iam-policy linear-client-secret
```

You should see your client ID, one `enabled` version, and `roles/secretmanager.secretAccessor` for `ganttsmart-run`.

---

## Step 6: Get the code and run the Firestore tests once

**What this does:** downloads the code into Cloud Shell and runs the storage tests against a local Firestore emulator, to prove the Firestore code works before any real data is written. (These tests can't run on a normal laptop without extra tools, and they never touch the real database.)

```bash
cd ~
git clone https://github.com/Blue-Core-Energy/ganttsmart.git
cd ~/ganttsmart

# The tests need Node 22.12 or newer; Cloud Shell includes nvm
nvm install 22
node --version

npm ci
```

The fork is public (GitHub keeps forks of public repositories public), so `git clone` doesn't ask you to sign in. That's expected and safe: no secrets are in the repository. If you later move to a private repository, `git clone` will ask you to sign in: use your GitHub username and a [personal access token](https://github.com/settings/tokens) as the password.

Install the Firestore emulator. Cloud Shell installs `gcloud` with the system package manager, so the emulator comes from `apt` too. The notice about Cloud Shell being ephemeral is normal; the command carries on after 5 seconds.

```bash
sudo apt-get install -y google-cloud-cli-firestore-emulator
```

Start the emulator. It keeps running, so leave this tab alone:

```bash
gcloud emulators firestore start --host-port=localhost:8085
```

Wait for `Dev App Server is now running`. A warning that support for Java 21 will be dropped is fine; the emulator still runs. Only if it fails to start because of Java, switch to the newest Java that Cloud Shell offers and start it again ([Cloud Shell Java versions](https://cloud.google.com/shell/docs/how-cloud-shell-works), [emulator requirements](https://cloud.google.com/firestore/native/docs/emulator)):

```bash
update-java-alternatives --list          # shows the installed versions
sudo update-java-alternatives -s java-1.21.0-openjdk-amd64 && export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
java -version
```

(Use the highest version from the list, e.g. 25, in both places if it's there.) Then open a **second Cloud Shell tab** (the `+` next to the tab name) and run:

```bash
source ~/ganttsmart-vars.sh
cd ~/ganttsmart
nvm use 22
FIRESTORE_EMULATOR_HOST=localhost:8085 npx vitest run server/test/store.firestore.test.ts
```

**Check:** every test passes (none skipped) and the command returns to the prompt. Then go back to the first tab, press `Ctrl+C` to stop the emulator, and close the second tab.

If a test fails, stop here and report the output; don't deploy.

---

## Step 7: First deploy

**What this does:** builds the container image in Cloud Shell, uploads it, and creates the Cloud Run service with all of its settings. Later deploys from Cloud Build only change the image; everything set here carries over (see [Automatic deploys keep these settings](#automatic-deploys-keep-these-settings)).

Build and upload the image (5-10 minutes):

```bash
cd ~/ganttsmart
gcloud auth configure-docker ${REGION}-docker.pkg.dev --quiet
docker build -t $IMAGE:initial .
docker push $IMAGE:initial
```

Create the service:

```bash
gcloud run deploy $SERVICE \
  --image=$IMAGE:initial \
  --region=$REGION \
  --service-account=$RUN_SA \
  --no-allow-unauthenticated \
  --ingress=internal-and-cloud-load-balancing \
  --set-secrets=LINEAR_CLIENT_SECRET=linear-client-secret:latest \
  --set-env-vars=APP_ORIGIN=https://$DOMAIN,ALLOWED_EMAIL_DOMAIN=bluecore.energy,LINEAR_CLIENT_ID=$LINEAR_CLIENT_ID,LINEAR_REDIRECT_URI=https://$DOMAIN/api/linear/callback,IAP_AUDIENCE=/projects/$PROJECT_NUMBER/global/backendServices/pending
```

What the flags mean:

- `--service-account`: run as `ganttsmart-run`, which can only use Firestore and the one secret.
- `--no-allow-unauthenticated`: Cloud Run only accepts requests from callers with the **Cloud Run Invoker** role. Only IAP gets that role (next command).
- `--ingress=internal-and-cloud-load-balancing`: the public `*.run.app` address is refused; traffic must come through the load balancer ([Cloud Run ingress](https://cloud.google.com/run/docs/securing/ingress)).
- `--set-secrets`: the app reads `LINEAR_CLIENT_SECRET` from Secret Manager when an instance starts.
- `IAP_AUDIENCE=…/pending` is a placeholder: the real value only exists once the load balancer is built (step 8). Until step 10 replaces it, every API call is refused, which is safe.

Now let IAP call the service. With IAP on the load balancer's backend service, IAP calls Cloud Run as its own service agent, which needs the Cloud Run Invoker role ([Enable IAP for Cloud Run](https://cloud.google.com/iap/docs/enabling-cloud-run)):

```bash
gcloud services identity create --service=iap.googleapis.com --project=$PROJECT_ID
gcloud run services add-iam-policy-binding $SERVICE --region=$REGION \
  --member=serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com \
  --role=roles/run.invoker
```

**Check:**

```bash
gcloud run services describe $SERVICE --region=$REGION --format=yaml | grep -E 'run.googleapis.com/ingress:|serviceAccountName:'
gcloud run services get-iam-policy $SERVICE --region=$REGION
gcloud run services logs read $SERVICE --region=$REGION --limit=20
```

You should see `run.googleapis.com/ingress: internal-and-cloud-load-balancing` and `serviceAccountName: ganttsmart-run@…`; an IAM policy whose only `roles/run.invoker` member is `service-…@gcp-sa-iap.iam.gserviceaccount.com` (no `allUsers`); and a `server started` log line with `"mode":"iap"`.

---

## Step 8: Build the load balancer

**What this does:** creates the public entry point at a fixed IP address, with a Google-managed HTTPS certificate for `ganttsmart.bluecore.energy`, and sends plain HTTP to HTTPS. Commands follow [Set up a global external Application Load Balancer with Cloud Run](https://cloud.google.com/load-balancing/docs/https/setup-global-ext-https-serverless) and [HTTP-to-HTTPS redirect](https://cloud.google.com/load-balancing/docs/https/setting-up-global-http-https-redirect).

Nothing is reachable yet: until IAP is on (step 10), Cloud Run refuses the load balancer's requests because they carry no invoker identity.

```bash
# 1. Static IP address
gcloud compute addresses create ganttsmart-ip --network-tier=PREMIUM --ip-version=IPV4 --global
export LB_IP=$(gcloud compute addresses describe ganttsmart-ip --global --format='get(address)')
echo "export LB_IP=$LB_IP" >> ~/ganttsmart-vars.sh
echo $LB_IP

# 2. Serverless network endpoint group pointing at the Cloud Run service
gcloud compute network-endpoint-groups create ganttsmart-neg \
  --region=$REGION --network-endpoint-type=serverless --cloud-run-service=$SERVICE

# 3. Backend service, with the NEG as its backend
gcloud compute backend-services create ganttsmart-backend \
  --load-balancing-scheme=EXTERNAL_MANAGED --global
gcloud compute backend-services add-backend ganttsmart-backend --global \
  --network-endpoint-group=ganttsmart-neg --network-endpoint-group-region=$REGION

# 4. URL map: send everything to the backend service
gcloud compute url-maps create ganttsmart-urlmap --default-service=ganttsmart-backend

# 5. Google-managed certificate for the domain
gcloud compute ssl-certificates create ganttsmart-cert --domains=$DOMAIN --global

# 6. HTTPS proxy and forwarding rule on port 443
gcloud compute target-https-proxies create ganttsmart-https-proxy \
  --ssl-certificates=ganttsmart-cert --url-map=ganttsmart-urlmap
gcloud compute forwarding-rules create ganttsmart-https-rule \
  --load-balancing-scheme=EXTERNAL_MANAGED --network-tier=PREMIUM \
  --address=ganttsmart-ip --target-https-proxy=ganttsmart-https-proxy --global --ports=443
```

HTTP-to-HTTPS redirect on port 80, on the same IP:

```bash
cat > /tmp/ganttsmart-http-redirect.yaml <<EOF
kind: compute#urlMap
name: ganttsmart-http-redirect
defaultUrlRedirect:
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  httpsRedirect: true
tests:
- description: Redirects to HTTPS
  host: $DOMAIN
  path: /app
  expectedOutputUrl: https://$DOMAIN/app
  expectedRedirectResponseCode: 301
EOF
gcloud compute url-maps validate --source=/tmp/ganttsmart-http-redirect.yaml
gcloud compute url-maps import ganttsmart-http-redirect --source=/tmp/ganttsmart-http-redirect.yaml --global --quiet
gcloud compute target-http-proxies create ganttsmart-http-proxy --url-map=ganttsmart-http-redirect --global
gcloud compute forwarding-rules create ganttsmart-http-rule \
  --load-balancing-scheme=EXTERNAL_MANAGED --network-tier=PREMIUM \
  --address=ganttsmart-ip --target-http-proxy=ganttsmart-http-proxy --global --ports=80
```

**Check:** `gcloud compute forwarding-rules list --global` shows `ganttsmart-https-rule` (port 443) and `ganttsmart-http-rule` (port 80), both on `$LB_IP`. The certificate stays `PROVISIONING` until DNS is set up in the next step.

---

## Step 9: Point the domain at the load balancer (DNS)

**What this does:** makes `ganttsmart.bluecore.energy` resolve to the load balancer, which also lets Google issue the HTTPS certificate.

At Bluecore's DNS provider, in the `bluecore.energy` zone, add:

| Type | Name / host | Value | TTL |
|---|---|---|---|
| `A` | `ganttsmart` | the IP from `echo $LB_IP` | 300 (or the provider's default) |

Don't add an `AAAA` record. If a `CAA` record exists for `bluecore.energy`, it must allow `pki.goog` or Google can't issue the certificate ([Google-managed certificates](https://cloud.google.com/load-balancing/docs/ssl-certificates/google-managed-certs)).

**Check:**

```bash
dig +short $DOMAIN          # prints $LB_IP (may take a few minutes after adding the record)
gcloud compute ssl-certificates describe ganttsmart-cert --global --format='value(managed.status,managed.domainStatus)'
```

The certificate moves from `PROVISIONING` to `ACTIVE`, usually within 15-60 minutes of DNS resolving, occasionally longer ([certificate troubleshooting](https://cloud.google.com/load-balancing/docs/ssl-certificates/troubleshooting)). You can carry on with step 10 while it provisions.

---

## Step 10: Turn on IAP and set the app's IAP audience

**What this does:** puts Google sign-in in front of the app, allows everyone with a `@bluecore.energy` account, and tells the app which IAP-signed header to trust.

### 10a. Sign-in screen: internal (organization-only)

IAP on a load balancer uses a **Google-managed OAuth client** by default, which only lets in users inside your organization. No OAuth client ID or secret needs creating ([Use custom OAuth clients with IAP](https://cloud.google.com/iap/docs/custom-oauth-configuration)).

To make the internal-only setting explicit, *verify in console*:

1. Open <https://console.cloud.google.com/auth/branding> for the project.
2. If it says **Get started**, click it and enter: **App name** `GanttSmart`, **User support email** your address, **Audience** **Internal**, **Contact information** your address. Click **Create**.
3. If branding already exists, open **Audience** and confirm the user type is **Internal**.

### 10b. Enable IAP on the backend service

```bash
gcloud iap web enable --resource-type=backend-services --service=ganttsmart-backend
```

([`gcloud iap web enable`](https://cloud.google.com/sdk/gcloud/reference/iap/web/enable).) If that command insists on OAuth credentials, use the equivalent from the [IAP for Cloud Run guide](https://cloud.google.com/iap/docs/enabling-cloud-run), which uses the Google-managed client:

```bash
gcloud compute backend-services update ganttsmart-backend --global --iap=enabled
```

### 10c. Let `@bluecore.energy` in

```bash
gcloud iap web add-iam-policy-binding --resource-type=backend-services --service=ganttsmart-backend \
  --member=domain:bluecore.energy --role=roles/iap.httpsResourceAccessor
```

This grants **IAP-secured Web App User** to the whole domain ([Manage access to IAP-secured resources](https://cloud.google.com/iap/docs/managing-access)). To narrow access later, grant a Google Group (`group:…@bluecore.energy`) instead and remove the domain binding; no app change is needed.

### 10d. Set the IAP audience and redeploy

The app only accepts IAP headers addressed to this backend service. For a backend service the audience is `/projects/PROJECT_NUMBER/global/backendServices/SERVICE_ID`, where `SERVICE_ID` is the backend service's numeric `id` ([Getting the user's identity with signed headers](https://cloud.google.com/iap/docs/signed-headers-howto)):

```bash
export BACKEND_SERVICE_ID=$(gcloud compute backend-services describe ganttsmart-backend --global --format='value(id)')
echo "export BACKEND_SERVICE_ID=$BACKEND_SERVICE_ID" >> ~/ganttsmart-vars.sh
echo $BACKEND_SERVICE_ID

gcloud run services update $SERVICE --region=$REGION \
  --update-env-vars=IAP_AUDIENCE=/projects/$PROJECT_NUMBER/global/backendServices/$BACKEND_SERVICE_ID
```

Use `--update-env-vars` (changes one variable), never `--set-env-vars` here: `--set-env-vars` first removes every existing variable ([`gcloud run deploy` reference](https://cloud.google.com/sdk/gcloud/reference/run/deploy)).

You can cross-check the audience in the console: **Security → Identity-Aware Proxy**, the `ganttsmart-backend` row's **⋮ → Signed Header JWT Audience**.

**Check:**

```bash
gcloud compute backend-services describe ganttsmart-backend --global --format='value(iap.enabled)'   # True
gcloud iap web get-iam-policy --resource-type=backend-services --service=ganttsmart-backend          # domain:bluecore.energy
gcloud run services describe $SERVICE --region=$REGION --format=yaml | grep -A1 IAP_AUDIENCE          # …/backendServices/<number>
```

Once the certificate is `ACTIVE`, opening `https://ganttsmart.bluecore.energy` in a browser should ask you to sign in with Google and then show the app. IAP changes can take a few minutes to apply.

---

## Step 11: Automatic deploys from GitHub (Cloud Build trigger)

**What this does:** connects Cloud Build to `Blue-Core-Energy/ganttsmart` so that every push to `main` builds a new image and rolls it out, using [`cloudbuild.yaml`](../cloudbuild.yaml). This comes after the first deploy on purpose: the trigger only swaps the image on an existing, fully configured service.

### 11a. Connect the GitHub repository (console)

1. Open <https://console.cloud.google.com/cloud-build/repositories/2nd-gen> and click **Create host connection**.
2. **Provider** GitHub, **Region** `us-west2`, **Name** `github`. Click **Connect**. (If `us-west2` isn't offered, pick `us-central1` and use `--region=us-central1` and `locations/us-central1` in the trigger commands below; the service still deploys to `us-west2`.)
3. Authorize the **Cloud Build GitHub App**, then install it on the `Blue-Core-Energy` organization, giving it access to the `ganttsmart` repository only. (This needs a GitHub owner of `Blue-Core-Energy`.)
4. Back in Cloud Build, click **Link repository**, choose connection `github` and repository `Blue-Core-Energy/ganttsmart`, keep the generated name `Blue-Core-Energy-ganttsmart`, and click **Link**.

Background: [Connect to a GitHub repository](https://cloud.google.com/build/docs/automating-builds/github/connect-repo-github?generation=2nd-gen). If the console uses a different repository name, use that name in the next command.

### 11b. Create the trigger

```bash
gcloud builds triggers create github \
  --name=ganttsmart-main \
  --region=$REGION \
  --repository=projects/$PROJECT_ID/locations/$REGION/connections/github/repositories/Blue-Core-Energy-ganttsmart \
  --branch-pattern='^main$' \
  --build-config=cloudbuild.yaml \
  --service-account=projects/$PROJECT_ID/serviceAccounts/$BUILD_SA
```

`cloudbuild.yaml` sets `logging: CLOUD_LOGGING_ONLY`, which Cloud Build requires when a build runs as your own service account.

### Automatic deploys keep these settings

`cloudbuild.yaml` runs only `gcloud run deploy ganttsmart --image=… --region=us-west2`. Cloud Run carries a service's configuration forward to each new revision unless a command explicitly changes it ("Subsequent revisions will also automatically get this configuration setting unless you make explicit updates to change it": [Cloud Run environment variables](https://cloud.google.com/run/docs/configuring/services/environment-variables)). So the environment variables, the secret reference, the runtime service account, ingress and the IAM policy set in steps 7 and 10 stay as they are. The check below confirms it after the first automatic deploy.

**Check:** run the trigger once by hand and confirm the settings survived:

```bash
gcloud builds triggers run ganttsmart-main --region=$REGION --branch=main
gcloud builds list --region=$REGION --limit=1          # wait until STATUS is SUCCESS (about 5-10 minutes)
gcloud run services describe $SERVICE --region=$REGION --format=yaml | grep -E 'image:|run.googleapis.com/ingress:|serviceAccountName:'
gcloud run services describe $SERVICE --region=$REGION --format=yaml | grep -E -A1 'name: (APP_ORIGIN|IAP_AUDIENCE|LINEAR_CLIENT_SECRET)'
```

The image now ends in a 7-character commit hash instead of `:initial`, the service account and ingress are unchanged, and the three variables are still present. If ingress shows anything other than `internal-and-cloud-load-balancing`, run `gcloud run services update $SERVICE --region=$REGION --ingress=internal-and-cloud-load-balancing` and report it.

---

## Step 12: Verification checklist

Do every check. Use a normal browser window for your Bluecore account and a private/incognito window for the outsider account.

- [ ] **HTTP redirects to HTTPS.** `curl -sI http://$DOMAIN | head -3` shows `301` and `Location: https://ganttsmart.bluecore.energy:443/` (or without `:443`).
- [ ] **Unauthenticated requests are stopped by IAP.** `curl -sI https://$DOMAIN/app | grep -iE '^(HTTP|location|x-goog-iap-generated-response)'` shows a `302` redirect to `accounts.google.com` (or a `401`) and `x-goog-iap-generated-response: true`, meaning IAP answered and the app was never reached.
- [ ] **The `.run.app` address is refused.** `curl -s -o /dev/null -w '%{http_code}\n' $(gcloud run services describe $SERVICE --region=$REGION --format='value(status.url)')/app` prints `404` or `403`, never `200`.
- [ ] **A non-Bluecore account is refused.** In a private window, open `https://ganttsmart.bluecore.energy` and sign in with the personal Gmail account. IAP shows an access-denied page; the app never loads.
- [ ] **A Bluecore account gets in.** In your normal window, open `https://ganttsmart.bluecore.energy`. After Google sign-in you land in the app (no GanttSmart login screen, no marketing page). `https://ganttsmart.bluecore.energy/api/me` shows your email and `"linearConnected":false`.
- [ ] **The app checks the IAP header properly.** While signed in, open `https://ganttsmart.bluecore.energy/api/me?gcp-iap-mode=SECURE_TOKEN_TEST&iap-secure-token-test-type=AUDIENCE`: it must return `{"error":"unauthorized"}` (401). With `iap-secure-token-test-type=SIGNATURE` it must also return 401. With `iap-secure-token-test-type=NOT_SET` (a valid test token) it should return your email ([IAP query parameters](https://cloud.google.com/iap/docs/special-urls-howto)).
- [ ] **Connecting Linear keeps the IAP session.** Click **Connect Linear**, approve in Linear, and you are sent back through `https://ganttsmart.bluecore.energy/api/linear/callback`. **Expected:** you land on `/app` connected, with your Linear projects loading. **Not expected:** a Google sign-in page, a sign-in loop, or an error banner. If you see either, note the exact URL and stop.
- [ ] **Edit and reload.** Drag an issue's dates in the Gantt chart, confirm the change in Linear, then reload the page. The change is still there, and the issue's history panel shows the edit.
- [ ] **Disconnect and reconnect.** Disconnect Linear in the app (it shows the connect prompt), then connect again; it works without errors.
- [ ] **No errors in the logs.** `gcloud run services logs read $SERVICE --region=$REGION --limit=50` shows only the `IAP identity check failed` errors caused by the deliberate `AUDIENCE` and `SIGNATURE` test tokens above, and no other `ERROR` lines.
- [ ] **Secret rotation works.** Do the rotation in [Rotate the Linear client secret](#rotate-the-linear-client-secret) once, then repeat the Linear connect check.

---

## Rotate the Linear client secret

Do this if the secret may have leaked, or on a regular schedule.

1. In Linear, open the GanttSmart OAuth application (**Settings → API → OAuth applications**) and rotate (regenerate) the client secret. *Verify in Linear:* the button name may differ. Copy the new secret.
2. Store it as a new version, and roll out a new revision so instances pick it up (secrets exposed as environment variables are read when an instance starts: [Configure secrets for Cloud Run](https://cloud.google.com/run/docs/configuring/services/secrets)):

   ```bash
   source ~/ganttsmart-vars.sh
   read -rs -p "New Linear client secret: " LINEAR_SECRET && echo
   printf '%s' "$LINEAR_SECRET" | gcloud secrets versions add linear-client-secret --data-file=-
   unset LINEAR_SECRET
   gcloud run services update $SERVICE --region=$REGION \
     --update-env-vars=LINEAR_SECRET_ROTATED_AT=$(date -u +%Y%m%dT%H%M%SZ)
   ```

   (`LINEAR_SECRET_ROTATED_AT` is ignored by the app; changing it forces a new revision.)
3. Connect Linear again in the app to confirm the new secret works.
4. Disable the old version (the list shows version numbers; the old one is the lower number):

   ```bash
   gcloud secrets versions list linear-client-secret
   gcloud secrets versions disable OLD_VERSION_NUMBER --secret=linear-client-secret
   ```

People who were already connected stay connected: their stored Linear tokens don't depend on the client secret until their next token refresh, which uses the new secret automatically.

---

## Rolling back a bad deploy

Each deploy creates a new Cloud Run **revision**; old ones stay available ([Rollbacks and traffic migration](https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)).

```bash
source ~/ganttsmart-vars.sh
gcloud run revisions list --service=$SERVICE --region=$REGION
# Send all traffic to a known-good revision (the REVISION column):
gcloud run services update-traffic $SERVICE --region=$REGION --to-revisions=GOOD_REVISION_NAME=100
```

**Traffic stays pinned after a rollback.** Once traffic is assigned to a particular revision, every later deploy keeps that assignment: Cloud Build keeps reporting successful deploys, but nobody sees them ([Rollbacks and traffic migration](https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)). So after you fix or revert the change on `main` and Cloud Build has deployed it, you **must** send traffic back to the newest revision:

```bash
gcloud run services update-traffic $SERVICE --region=$REGION --to-latest
```

**Check:** `gcloud run services describe $SERVICE --region=$REGION --format='value(status.traffic)'` shows the latest revision (`latestRevision=True`) at `percent=100`.

To stop automatic deploys temporarily, open the Cloud Build **Triggers** page (<https://console.cloud.google.com/cloud-build/triggers>, region `us-west2`), click **⋮** on `ganttsmart-main` and choose **Disable**; choose **Enable** to turn it back on.

From Cloud Shell instead, export the trigger, change it and import it back ([`triggers export`](https://cloud.google.com/sdk/gcloud/reference/beta/builds/triggers/export) is a beta command; [`triggers import`](https://cloud.google.com/sdk/gcloud/reference/builds/triggers/import)):

```bash
gcloud beta builds triggers export ganttsmart-main --region=$REGION --destination=trigger.yaml
# Edit trigger.yaml: add or change the line `disabled: true` (set it to false to re-enable)
gcloud builds triggers import --region=$REGION --source=trigger.yaml
```

## Taking it down

**Everything at once:** shutting down the project deletes every resource in it (recoverable for 30 days), and stops all charges:

```bash
gcloud projects delete $PROJECT_ID
```

Then remove the `ganttsmart` A record at the DNS provider and delete the OAuth application in Linear.

**Only the public entry point** (keeps data, image and service; nobody can reach the app):

First remove the `ganttsmart` A record at the DNS provider (before, or immediately after, deleting `ganttsmart-ip`). Once the IP is released Google can give it to someone else, and a record still pointing at it would let them serve content as `ganttsmart.bluecore.energy`.

```bash
gcloud compute forwarding-rules delete ganttsmart-https-rule ganttsmart-http-rule --global --quiet
gcloud compute target-https-proxies delete ganttsmart-https-proxy --global --quiet
gcloud compute target-http-proxies delete ganttsmart-http-proxy --global --quiet
gcloud compute url-maps delete ganttsmart-urlmap ganttsmart-http-redirect --global --quiet
gcloud compute ssl-certificates delete ganttsmart-cert --global --quiet
gcloud compute backend-services delete ganttsmart-backend --global --quiet
gcloud compute network-endpoint-groups delete ganttsmart-neg --region=$REGION --quiet
gcloud compute addresses delete ganttsmart-ip --global --quiet
```

## Later improvements (not needed now)

- **Sign out.** IAP supports clearing its login cookie with `https://ganttsmart.bluecore.energy/?gcp-iap-mode=CLEAR_LOGIN_COOKIE` ([IAP query parameters](https://cloud.google.com/iap/docs/special-urls-howto)). The GCP build currently hides **Sign out**; showing it and linking it to that URL is a separate app change. Note that with a single Google account signed in, the browser may sign straight back in.
- **Narrow access to a Google Group** instead of the whole domain (step 10c).
- **Pin the secret version.** Google recommends pinning a version number rather than `latest` for secrets exposed as environment variables. This guide uses `latest` plus the explicit redeploy in the rotation steps.
- **Disable the `run.app` URL entirely** with `gcloud run services update ganttsmart --region=us-west2 --no-default-url`. Ingress already blocks it; this removes it ([Cloud Run ingress](https://cloud.google.com/run/docs/securing/ingress)).
- **IAP directly on Cloud Run.** Google now recommends enabling IAP on the Cloud Run service itself when there's only one region ([Enable IAP for Cloud Run](https://cloud.google.com/iap/docs/enabling-cloud-run)). IAP can't be on both the load balancer and the service, and switching changes the audience to `/projects/PROJECT_NUMBER/locations/us-west2/services/ganttsmart`, so it would mean redoing step 10.
- **Cloud Armor** rate limiting on the backend service.
