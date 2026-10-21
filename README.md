# Sensara

Visual and audio monitoring prototype, originally built at KeanUHacks. Uses fictional residents for demonstrations. Heuristic detections require human review; demonstration success does not establish clinical reliability or production readiness.

## Run locally

Requires Node 22+, npm, and the configured MongoDB Atlas replica set. Your private settings are in `elderwatch-ai/.env.local`; keep that file out of Git. On a fresh checkout copy `.env.local.example` only if `.env.local` does not exist.

```sh
cd elderwatch-ai
npm ci
npm run db:migrate -- --demo
npm run dev -- --port 3002
```

Production build on your computer:

```sh
npm run check
NOTIFICATION_WORKER_ENABLED=false npm run build
npm start -- --port 3002
```

Open http://127.0.0.1:3002. Ctrl+C stops the server. The local npm commands bind to loopback. `LOCAL_DEMO_MODE=true` permits local fictional demonstrations; it is disabled on Railway. Production API requests fail when MongoDB is not configured. In-memory storage is used by isolated unit tests, never as a fallback when Atlas fails.

Monitoring starts paused. Select the consent checkbox, then Resume. Live Camera asks for camera permission; microphone monitoring has its own explicit control and must be enabled in the patient record. Enable Audio Alerts separately. Browser playback can be blocked; use Play blocked alert to start the prepared audio directly. Playback completion does not prove anyone heard the alert.

## Existing monitoring modes

The four prerecorded feeds retain the original timed scenarios, rather than running new detection on their footage:

| Feed | Fictional patient | Room | Original behavior |
| --- | --- | --- | --- |
| Fall | Eleanor Brooks | 204 | Normal before 5s; watching before 10s; urgent from 10s |
| Stable | Robert Hayes | 118 | Normal throughout |
| Wandering | Margaret Chen | 312 | Normal before 13s; watching thereafter |
| Choking | Daniel Price | Lounge Area | Normal before 4s; urgent thereafter |

Live Camera uses the existing MediaPipe model and rules in `classifySafety.ts` and `poseHelpers.ts`. Scores are heuristics, not calibrated probabilities. Browser observations are authenticated client evidence, not independently verified clinical findings. Missing or stale observations display UNKNOWN.

## Shared incident workflow

Every monitoring mode uses `platform/incidents.ts`. The server resolves patient identity, validates the monitoring session and event ordering, and derives camera/demo classifications. MongoDB transactions save event ingestion, episode changes, observations, and embedded workflow intents together. Provider calls occur after commit.

One active episode exists per patient and event category, enforced by unique indexes. Fall risk/posture and possible fall share a category so a watching incident can promote. New request IDs identify new observations; retries must reuse the same ID. Page refresh retains the active episode. Closing an episode does not reopen it: camera rearming requires fresh normal observations across five seconds before a new abnormal episode. This is a software stability rule, not a statement of patient safety. Explicit manual events can start a new episode.

Responses: OPEN → ACKNOWLEDGED → RESOLVED; OPEN or ACKNOWLEDGED → DISMISSED. Resolution/dismissal requires a reason. The server records actor identity, timestamp and audit history; terminal records remain stored. Acknowledgment does not resolve an incident or cancel evidence capture. Active urgent incidents remain urgent independently of observation or camera health. Reminders are disabled.

The persistent Node worker polls MongoDB every three seconds with atomic claims, expiring leases and conditional completion. Messaging intents are recovered after restart. Accepted messages are not resent for a video failure. Ambiguous submitted messages remain UNKNOWN for manual review; retries may duplicate a provider send. Rate-limit retries are bounded with backoff. Voice and messaging run independently from the 15-second clip.

## Configuration

Secrets are environment variables only. Nonsecret preferences and staff notification assignments persist in MongoDB. The dashboard provides patient create/edit/deactivate and integration preferences. Staff recipients are managed through the admin-only `/api/staff` API; each record has `id`, `name`, `active`, `urgentAlerts`, `patientIds`, `channel`, and `destination`. An authenticated staff account's patient scope is in `STAFF_ACCOUNTS_JSON`; notification assignments do not grant login access.

| Service | Variables / requirements |
| --- | --- |
| Atlas | `MONGODB_URI`, `MONGODB_DB`; replica set/transactions required |
| S3 | `AWS_REGION`, `S3_VIDEO_BUCKET` or `AWS_S3_BUCKET`; AWS SDK credential chain (role, profile, or local key/token) |
| ElevenLabs | `ELEVENLABS_API_KEY` with Speech to Text and Text to Speech permissions; `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID` |
| Photon iMessage | `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`; authorized recipient in Photon and assigned staff record |
| Optional SMS | Twilio SID/token/from number; separate `sms` recipient assignment |
| Optional email | Resend key/from address; separate `email` assignment |
| Worker | `NOTIFICATION_WORKER_ENABLED=true` on an always-running Node service |
| Auth | `AUTH_SESSION_SECRET` (32+ random characters), `STAFF_ACCOUNTS_JSON`, `APP_ORIGIN` |

`CAREGIVER_PHONE_NUMBER` seeds the fictional demo recipient with `db:migrate -- --demo`. Only explicit configured recipients receive messages. Generic external notices are the default; `dataMode=demo` permits fictional patient names and rooms. Real patient data requires a separately reviewed privacy, consent, access and provider-agreement setup. Anthropic assistant calls are restricted to demo mode; otherwise local guidance is used.

Photon is iMessage, not conventional SMS. ACCEPTED is not DELIVERED. The current integration does not consume delivery receipts and does not claim device delivery. Provider failure details are sanitized. Provider secrets never enter browser bundles.

### Staff authentication

Set `LOCAL_DEMO_MODE=false` outside the local fictional demo. Accounts use scrypt password hashes and signed, HttpOnly, eight-hour sessions. Role and patient access are reloaded from server configuration on each request. Cross-origin writes are rejected.

Create an account entry using `scripts/create-staff.mjs`, feeding a password through stdin from a private file or password-manager pipe (avoid plaintext command-line arguments). Put the resulting entry in the `STAFF_ACCOUNTS_JSON` array. Roles are admin, caregiver and viewer. Use `openssl rand -hex 32` for a fresh session secret. No production staff credentials are provisioned automatically.

### Video storage

Recordings use the explicit 15-second post-event fallback; no pre-event buffer is claimed. Partial/unavailable captures are labeled and do not mark a full clip available. Camera loss, patient switching or leaving the page can lose uncaptured footage. A worker cannot reconstruct it. Existing microphone tracks are included only after explicit audio consent.

S3 stays private. The IAM scope is GetObject/PutObject under `critical-events/*`; keys include patient, incident and upload IDs. Presigned PUT/GET URLs expire in five minutes. PUT uses If-None-Match to prevent overwrites. The server checks ownership, type, size (50 MB maximum), container signature and fully decodes the video with ffmpeg before linking it. Actual media duration is measured separately from capture timestamps. The ffmpeg-static npm dependency supplies local decoding; Docker uses Alpine ffmpeg.

Playback access expires according to `retentionDays`. Physical S3 deletion is a separate bucket lifecycle setting and is not yet applied by this app. Current IAM has no delete/admin permission. Do not describe access expiry as object deletion. Secure server logging, bucket access logging, lifecycle policy and organizational retention approval remain deployment work.

## Migration and Railway

`npm run db:migrate` applies additive validators and unique indexes. `--demo` additionally seeds missing fictional records and the configured demo recipient. Existing history is preserved. Index conflicts stop migration; inspect duplicates before proceeding. No destructive cleanup is automatic.

Collections: residents, safety_events, monitoring_sessions, monitoring_observations, event_ingestions, notifications, video_clips, upload_intents, voice_assets, caregiver_notes, staff and application_settings. Incident workflow intents are embedded atomically in safety_events; notifications materialize idempotently from those intents.

Railway uses `elderwatch-ai/Dockerfile` and `railway.json`, with `/api/health` checking database availability. Set service Root Directory to `/elderwatch-ai`, configure runtime variables, and run the migration against the destination Atlas database before deployment. Keep the Node service running for worker polling; multiple processes use MongoDB claims. Set `APP_ORIGIN` to the HTTPS deployment URL and configure staff accounts. Docker uses `PORT` and `0.0.0.0`. No Vercel token or integration is required. Railway deployment itself has not been verified.

## Verification

```sh
npm run check
npm run build
```

The CI workflow runs lint, types, unit/mock integration tests and production build without cloud secrets. Opt-in live scripts refuse databases without the `sensara_verification_` prefix:

```sh
SENSARA_LIVE_TESTS=1 MONGODB_DB=sensara_verification_YOUR_RUN node --env-file=.env.local --import tsx scripts/live-database-check.ts
# Run the same command with --read-after-restart to verify persisted audit/history.
```

`live-provider-check.ts` performs actual S3/TTS/Photon calls and must only be run with explicit approval, fictional data and an approved recipient. It expects a synthetic `/private/tmp/sensara-synthetic-15s.mp4`. `live-recovery-check.ts` verifies the uploaded media and real Atlas rollback/leases using mocked messaging. These scripts are manual verification tools, not CI jobs. Read `VERIFICATION_REPORT.txt` for exact passed checks and external blockers.
