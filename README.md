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

Monitoring starts paused. Each demo tile has its own Play/Pause button. Start demo starts or resumes all four feeds, including individually paused feeds; Pause all stops them together. Pausing preserves each video’s playback position. Starting a feed authorizes its monitoring, recordings and configured alerts. Selecting Live Camera opens the camera and starts monitoring automatically; Pause monitoring stops it. The browser must grant camera access on first use; the application cannot bypass that permission. Switching modes pauses demo feeds, and returning does not automatically restart them. Paused tiles display an explicit overlay; saved incidents remain visible and unresolved until staff respond. Alerts and notification history are in the right sidebar on desktop. Live Camera asks for camera permission; microphone monitoring has its own explicit control and must be enabled in the patient record. Enable Audio Alerts separately. Browser playback can be blocked; use Play blocked alert to start the prepared audio directly. Playback completion does not prove anyone heard the alert.

## Existing monitoring modes

The four prerecorded videos now run real Google MediaPipe Pose Landmarker Full inference in browser workers. Their timestamps no longer select alert severity. The workers sample decoded frames at up to 5 Hz and draw the measured skeleton. The same bounded landmark window is classified again by the authenticated backend before creating or promoting an incident. MediaPipe assets are served locally; inference does not upload video to Google.

| Feed | Fictional patient | Room | Measured-demo review |
| --- | --- | --- | --- |
| Fall | Eleanor Brooks | 204 | Reaching stays below urgent; brief obscured geometry is UNKNOWN; sampled fall escalates around 11.2s |
| Stable | Robert Hayes | 118 | Sitting/walking samples remain stable |
| Wandering | Margaret Chen | 312 | Sustained absence becomes WATCHING with Person out of view; no invented urgent event |
| Neck gesture | Daniel Price | Lounge Area | Brief gesture watches; either hand held near the neck for 3 observed seconds escalates (around 7.0s in the recorded samples); this does not confirm choking |

These times describe one 5 Hz measurement run on the bundled clips, not runtime timers or accuracy claims. Realtime sampling, partial body visibility, perspective and model errors can change outcomes. A missing pose or an implausible switch to furniture must not be presented as normal tracking. Samples and provenance are in `tests/fixtures/recorded-poses.*`.

Tile color and the **Observation / Last observation** badge describe current or paused-frame evidence. **Patient priority: CRITICAL — unresolved saved incident** is a separate notice; incident history and response controls remain on the right. Old incidents never overwrite the current frame's color and are not automatically closed by playback, pausing or a lower observation.

`poseEvidence.ts` is the shared browser/server policy. These are prototype engineering choices, **not medically validated thresholds**:

- **Possible distress / neck gesture:** either visible hand held near the neck for 3 observed seconds becomes urgent, including upper-body views with cropped hips. The hands have independent timers, so alternating short gestures cannot combine into an urgent hold. Brief boundary jitter under 0.4s can preserve accumulated evidence without adding time. Once a gesture has reached urgent, clearing it requires 1 continuous second of the hand visibly away from the neck. Up to 1.2s of tracking loss preserves candidate progress and an established warning. Missing or skipped intervals do not add gesture time; after longer loss, progress resets and sustained absence returns to Watching. Gesture evidence only accrues between visible samples no more than 0.4s apart; posture and fall continuity retain their separate 0.8s limit. Neither missing nor away intervals add evidence, and initial escalation still requires a visible gesture. This release rule is applied in the browser and server; saved incidents remain separate from the current observation. The camera's red marker and rings use the same geometry and visibility checks as the classifier. Expand **Live tracking diagnostics** under **Observed hand gesture** to see the processed sample rate, last sample gap, landmark visibility confidence, independent hand timers, current tracking blocker, and most recent reset in the 12-second evidence window. Confidence describes landmark visibility, not confidence that an emergency is occurring.
- **Possible fall:** torso tilt >=65 degrees, measured downward movement >0.35 prior torso lengths relative to an upright reference no older than 4s, then 0.8s of visible horizontal evidence. Reaching or a horizontal pose without that transition does not establish a fall. A measured transition can survive brief geometry loss while awaiting visible confirmation.
- **Sustained slumped posture:** torso tilt >=45 degrees with both visibly extended downward arms for 4 continuous seconds becomes urgent `unsafe_posture`. Each shoulder, elbow and wrist must be in frame with visibility >=0.5; elbows must be >=150 degrees with both arm segments directed downward. Occlusion or a changed arm posture resets this timer. This does not confirm a fall or unconsciousness.
- **Out of view:** one second of consecutive processed frames without a credible person produces WATCHING. Loading, failed tracking and partial-body ambiguity do not establish normal movement. Pauses, seeks and sampling gaps >0.8s reset continuity. A large position jump rejects a possible switch to furniture.

No percentage probability is shown for this detector; the legacy numeric confidence field is 0 (unscored) for compatibility. New measured incidents carry `detectionMethod=mediapipe_pose_v1`; historical incidents are not rewritten. Tests cover recorded samples, synthetic movements and the live hook → canvas badge → server observation path; these checks do not establish clinical accuracy.

Live Camera now uses the same local worker, full pose model and `poseEvidence.ts` rules as all four prerecorded videos. Camera acquisition, model loading and server session creation start concurrently. The preview remains visible while tracking starts; timeouts and Retry camera replace indefinite loading. Both camera and demo requests send bounded raw landmarks to the server for classification; old signal-only camera clients must refresh. Aspect ratio is measured from the actual source. Partial upper-body tracking can report sustained hand-to-neck gestures, but cannot establish normal full-body tracking or a fall. Browser landmarks remain authenticated client evidence, not independently verified clinical findings. The existing incident/outbox workflow is shared by both modes.

### Evidence and technology choice

[Google's Pose Landmarker documentation](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js) describes body landmarks and worker-based processing; it does not provide a medically validated fall/choking classifier. [NVIDIA's DeepStream pose example](https://github.com/NVIDIA-AI-IOT/deepstream_pose_estimation) requires a CUDA/TensorRT stack and is marked unmaintained, so it was not added to this browser/Mac application.

[CDC data](https://www.cdc.gov/falls/data-research/facts-stats/) reports that more than one in four older adults fall annually. This population statistic motivates monitoring, but cannot determine whether a particular frame is urgent and is not used as a per-frame score. [Real-world fall-detection evaluation research](https://pmc.ncbi.nlm.nih.gov/articles/PMC6068511/) explains why staged demonstrations cannot establish real-world clinical performance. Sensitivity, specificity, injury/choking diagnosis, multi-person identity tracking and clinical reliability remain unvalidated. Perspective/floor calibration and representative independent testing are required before any deployment involving real patients.

## Shared incident workflow

Every monitoring mode uses `platform/incidents.ts`. The server resolves patient identity, validates the monitoring session and event ordering, and derives camera/demo classifications. MongoDB transactions save event ingestion, episode changes, observations, and embedded workflow intents together. Provider calls occur after commit.

One current detection occurrence is tracked per patient and event category. A fresh Critical occurrence gets its own incident and clip even while the previous care incident remains open. Fall risk/posture and possible fall share a category so a watching incident can promote. New request IDs identify new observations; retries must reuse the same ID. Ongoing Critical samples and quick page refreshes retain the current occurrence. A new Critical occurrence can start after at least two seconds of continuous, visible non-critical observations, or in a new monitoring session after at least 30 seconds without an urgent observation. Missing tracking does not count as recovery. Prior incidents, response status and clips remain in history. Closing an episode does not reopen it: camera rearming requires fresh normal observations across five seconds before a new abnormal episode. This is a software stability rule, not a statement of patient safety. Explicit manual events can start a new episode.

Responses: OPEN → ACKNOWLEDGED → RESOLVED; OPEN or ACKNOWLEDGED → DISMISSED. Resolution/dismissal requires a reason. The server records actor identity, timestamp and audit history; terminal records remain stored. Acknowledgment does not resolve an incident or cancel evidence capture. Active urgent incidents remain urgent independently of observation or camera health. Reminders are disabled.

The persistent Node worker polls MongoDB every three seconds with atomic claims, expiring leases and conditional completion. Messaging intents are recovered after restart. Accepted messages are not resent for a video failure. Ambiguous submitted messages remain UNKNOWN for manual review; retries may duplicate a provider send. Rate-limit retries are bounded with backoff. Voice and messaging run independently from incident video capture.

## Configuration

If Atlas fails with `querySrv EBADRESP` or DNS timeouts, the optional
`MONGODB_DNS_SERVERS=1.1.1.1,8.8.8.8` setting selects DNS servers inside the Node
process. It does not change macOS settings. Restart the app after changing it.
This only addresses DNS: Atlas network access rules, credentials and TLS still
apply. The dashboard distinguishes database outages from sign-in failures and
provides Retry connection instead of leaving a dead-end loading screen.

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

Urgent observations display as **CRITICAL**. Each newly critical incident automatically records **15 seconds in Live Camera** or **7 seconds in Multi-feed Demo** (within the requested 5–8 seconds). A Watching incident promoted to Critical triggers capture even when its incident ID stays the same. Repeated urgent samples do not create duplicate recordings for that incident. The live camera shows a fixed notification while preparing and recording, then **Saving clip to S3…**, followed by the saved filename only after upload verification and linking succeed. Failures appear as alerts. Recordings start after escalation; no pre-event buffer is claimed. Partial/unavailable captures are labeled and do not mark a full clip available. Camera loss, patient switching or leaving the page can lose uncaptured footage. A worker cannot reconstruct it. Existing microphone tracks are included only after explicit audio consent.

S3 stays private. The IAM scope is GetObject/PutObject under `critical-events/*`; keys include patient and incident IDs plus readable timestamped filenames. Multi-feed files use the patient's first name (`eleanor-<timestamp>.webm`, `robert-<timestamp>.mp4`, etc.); live-camera files use `live-feed-demo-<timestamp>.webm` (or `.mp4`, according to browser support). Names come from the saved incident, not upload-client input. The server chooses the duration policy from the incident source and verifies both capture timestamps and decoded media duration. Presigned PUT/GET URLs expire in five minutes. PUT uses If-None-Match to prevent overwrites. The server checks ownership, type, size (50 MB maximum), container signature and fully decodes the video with ffmpeg before linking it. Actual media duration is measured separately from capture timestamps. The ffmpeg-static npm dependency supplies local decoding; Docker uses Alpine ffmpeg.

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
