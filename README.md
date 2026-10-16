# DEVFEST: Lost in Translation

Booth 2 for DEVFEST, organized by AWS Club at Birzeit University. An Arabic sentence travels through Amazon Translate using this fixed route:

`Arabic -> Japanese -> Russian -> French -> English -> Arabic`

The existing Meaning Guardian and AI Glitcher modes use the same normalized Levenshtein scoring and separate leaderboards.

## Windows quick start

Requirements: Node.js 20 or newer, npm, and optionally AWS CLI v2 for profile-based credentials.

Open PowerShell in the repository folder and run:

```powershell
npm ci
Copy-Item backend/.env.example backend/.env
npm run dev
```

Open `http://localhost:5173`. The frontend and API bind to localhost by default; the API is at `http://localhost:5000`.

Other useful commands:

```powershell
npm test
npm run build
npm run smoke:aws
npm run start
```

`npm run start` starts only the backend. Use `npm run dev --prefix frontend` or `npm run dev --prefix backend` to run one side.

## AWS credentials for beginners

The backend requires `DEVFEST_AWS_ACCOUNT_ID=530702499288`. Before reserving application quota or making any `TranslateText` request, it resolves an explicit credential source and calls STS `GetCallerIdentity`. Any other account is rejected. Credentials never belong in frontend files.

The unnamed/default AWS CLI profile is intentionally not accepted. Local live mode requires `AWS_PROFILE`; serverless production requires complete server-side environment credentials. Setting both sources at once is rejected to avoid ambiguity.

### Recommended: AWS IAM Identity Center (SSO)

1. Install AWS CLI v2.
2. Ask the AWS account administrator for the IAM Identity Center start URL, SSO region, account, and a permission set that allows only `translate:TranslateText` for this booth.
3. Configure a named profile:

   ```powershell
   aws configure sso --profile devfest-translate
   aws sso login --profile devfest-translate
   ```

4. In `backend/.env`, set:

   ```dotenv
   AWS_PROFILE=devfest-translate
   AWS_REGION=us-east-1
   DEVFEST_AWS_ACCOUNT_ID=530702499288
   ```

5. Run the real one-request smoke test:

   ```powershell
   npm run smoke:aws
   ```

Only a message beginning with `PASS` proves that STS verified account `530702499288` before a real translation succeeded. A wrong account, missing profile, expired login, or missing credentials is reported as `BLOCKED`; no Translate request is made.

The standalone smoke test makes one request outside the game server, so it is not included in the persisted booth counters and may still be billable by AWS.

Before running the smoke test, verify the named profile without using the default profile:

```powershell
aws sts get-caller-identity --profile devfest-translate
```

The returned `Account` must be exactly `530702499288`. Stop if it is anything else.

### If the DEVFEST account does not have a dedicated identity yet

Prefer IAM Identity Center as described above. If the account administrator instead chooses a dedicated IAM user:

1. Sign in to the AWS Console for DEVFEST and verify the displayed account ID is `530702499288`.
2. Open **IAM → Users → Create user** and create a DEVFEST-only programmatic user. Do not enable console access.
3. Attach only a policy allowing `translate:TranslateText` and `sts:GetCallerIdentity` on `*`.
4. Open the user’s **Security credentials** tab and create one access key for a CLI/local application.
5. On the local Windows computer, run `aws configure --profile devfest-translate` and enter the values directly into the CLI prompts. Do not paste them into source files, chat, or Git.
6. Run `aws sts get-caller-identity --profile devfest-translate` and confirm account `530702499288` before enabling live mode.

These IAM steps are manual. The application never creates or edits IAM users, policies, profiles, or access keys.

### Alternative: temporary environment credentials

The SDK also supports `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN`. Put temporary values only in the ignored `backend/.env` file or server-side deployment environment. Remove `AWS_PROFILE` when using them. Never paste credentials into chat, source code, Git, or Vite variables. Permanent access keys are discouraged.

The active AWS identity needs this IAM action:

```json
{
  "Effect": "Allow",
  "Action": [
    "translate:TranslateText",
    "sts:GetCallerIdentity"
  ],
  "Resource": "*"
}
```

An AWS administrator must create or assign that permission. This project does not change the AWS account.

## Cost and booth limits

Defaults in `backend/.env.example`:

```dotenv
MAX_TOTAL_AWS_REQUESTS=3000
MAX_TOTAL_TRANSLATED_CHARACTERS=300000
MAX_ATTEMPTS_PER_PLAYER=3
```

Before each of the five SDK calls, the backend atomically reserves one request and the number of submitted Unicode characters. These counters are written to `backend/sentences_log.json` before the SDK call, so failed and partially completed pipelines still consume the recorded application quota. Concurrent rounds cannot reserve beyond the configured caps. The SDK is configured for one HTTP attempt per stage so application accounting is predictable.

These are application controls, not AWS billing guarantees. They do not replace AWS Budgets, Cost Explorer, billing alerts, or service-side monitoring. Requests made by another program or AWS identity are outside these counters. Check AWS billing separately before and during DEVFEST.

Completed competitive attempts are counted by normalized player name. This is a casual shared-laptop booth rule, not authentication: a participant can bypass it by changing names.

Read non-secret status and remaining application quota at `GET /api/status`.

## Offline demonstrations

`OFFLINE_MODE` supports:

- `auto` (default): use live AWS; if application quota is already exhausted before the first stage, replay an exact matching recorded example.
- `always`: never call AWS; only exact recorded examples work.
- `disabled`: require live AWS and return errors instead of demonstrations.

Network, credential, permission, or mid-pipeline failures return a safe error instead of silently relabeling a partially attempted live round as offline. Offline results come only from examples already recorded in this repository. They are visibly labeled **Prerecorded offline demonstration**, do not contain generated intermediate stages, consume no live AWS quota, do not use player attempts, and are never written to the competitive leaderboard.

For an internet-free booth rehearsal, set `OFFLINE_MODE=always` and choose one of the matching recorded sentences from the sentence bank.

## Security controls

- Backend and Vite bind to `127.0.0.1` by default.
- CORS allows only the configured `CORS_ORIGINS` list.
- General API and sentence-bank-specific throttles are enabled.
- Sentence-bank additions must contain Arabic, cannot duplicate an existing normalized sentence, and have a stricter rate limit.
- Request bodies are limited to 32 KiB and sentences to 150 Unicode characters.
- AWS calls have a configurable timeout and one SDK attempt per stage.
- STS verifies the authenticated account before any billable translation; verification is cached only for the same credential fingerprint and expires within five minutes or before temporary credentials expire.
- Client errors use safe codes and do not expose upstream or server exception details.
- `.env`, dependencies, build output, and logs are ignored by Git.

To intentionally serve another local device, set `HOST` and add the exact frontend origin to `CORS_ORIGINS`. Doing so exposes the service to that network and should be paired with firewall and network controls.

## Local data and reset behavior

`backend/sentences_log.json` stores presets, competitive plays, recorded offline examples, persistent application usage, and completed-attempt counts. Keep a backup before the event.

When `DATABASE_URL` is present, the backend instead uses PostgreSQL for all shared mutable state. On Vercel, `DATABASE_URL` is mandatory and the server refuses to fall back to the local JSON file. Local development can continue using JSON simply by leaving `DATABASE_URL` unset.

PostgreSQL stores sentence presets, prerecorded offline examples, competitive plays, normalized-player attempt counts, active-round locks, and AWS application-usage counters. Quota reservation and round completion use transactions and row locks, so concurrent Vercel functions cannot reserve past a configured cap or complete the same player round twice.

The **New player** control clears the player name, sentence, result, score display, errors, offline label, and animation state. It preserves leaderboard history and application usage.

## Neon Free database setup

No Neon resources are created by this repository. In the Neon or Vercel Marketplace UI:

1. Create a Neon project on the **Free** plan. Do not enable a paid upgrade or add paid compute.
2. Create or select a production branch and database for this game.
3. Copy the **pooled** PostgreSQL connection string. Treat it as a secret.
4. For a one-time migration on Windows, put that value in ignored `backend/.env` as `DATABASE_URL`. Do not paste it into source code or a `VITE_` variable.
5. From the repository root, run:

   ```powershell
   npm run db:migrate
   ```

The migration applies `backend/db/schema.sql` and idempotently imports the existing presets, offline examples, leaderboard history, attempt counts, and the larger of the existing usage counters. It runs in one transaction and prints `PASS` only after commit. Running it again is safe, although new production data should be backed up before any future schema changes.

To use Neon during local development, keep `DATABASE_URL` in `backend/.env` and run `npm run dev`. To return to the local JSON store, remove only the `DATABASE_URL` line and restart.

## Vercel Hobby preparation

The Vite build is served from `frontend/dist`. `api/index.js` exposes the existing Express app as one Vercel Function, and `vercel.json` routes same-origin `/api/*` requests to it while preserving SPA refreshes.

Import the GitHub repository into Vercel with the repository root as the project root. Keep the committed build settings from `vercel.json`. Add these server-side environment variables for Production (and Preview only if previews should work):

```dotenv
DATABASE_URL=<pooled Neon connection string>
DEVFEST_AWS_ACCOUNT_ID=530702499288
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<DEVFEST account credential only>
AWS_SECRET_ACCESS_KEY=<DEVFEST account credential only>
# Required only when the credentials are temporary:
AWS_SESSION_TOKEN=<temporary session token>

MAX_TOTAL_AWS_REQUESTS=3000
MAX_TOTAL_TRANSLATED_CHARACTERS=300000
MAX_ATTEMPTS_PER_PLAYER=3
AWS_REQUEST_TIMEOUT_MS=8000
OFFLINE_MODE=auto

CORS_ORIGINS=https://YOUR-PROJECT.vercel.app
API_RATE_LIMIT_WINDOW_MS=60000
API_RATE_LIMIT_MAX=120
SENTENCE_BANK_RATE_LIMIT_WINDOW_MS=3600000
SENTENCE_BANK_RATE_LIMIT_MAX=20
```

Do not set `AWS_PROFILE` on Vercel; Vercel cannot access a local CLI profile. Do not create `VITE_DATABASE_URL`, `VITE_AWS_ACCESS_KEY_ID`, or any other browser-visible secret. If using a Vercel preview URL, add its exact origin to `CORS_ORIGINS` as a comma-separated value. Redeploy manually after changing environment variables.

Leave `VITE_API_URL` unset on Vercel. The production frontend then uses same-origin `/api` automatically.

Before a first deployment, migrate the database, verify the DEVFEST credential outside Vercel, and confirm its account is exactly `530702499288`. The deployed backend repeats STS verification before Translate and rejects every other account.

Neon, Vercel Hobby, and Amazon Translate each have independent usage limits and terms. The database must remain on Neon Free, and Vercel must remain on Hobby. Application counters do not guarantee an AWS billing ceiling; monitor the AWS account separately.

## DEVFEST preflight

1. Confirm `backend/.env` is ignored with `git status`.
2. Run `npm test` and `npm run build`.
3. Log in to the intended AWS profile and run `npm run smoke:aws`.
4. Confirm `/api/status` shows the intended region and quota.
5. Run one live round and verify five translation cards appear.
6. Set `OFFLINE_MODE=always`, restart, and verify a recorded sentence is labeled as a noncompetitive prerecorded demonstration.
7. Restore the intended `OFFLINE_MODE` and restart.
8. Test **New player** and confirm all participant-specific fields clear.
9. Monitor AWS billing separately throughout the event.
10. With Neon enabled, confirm `/api/status` reports `"storage": "postgres"`.
