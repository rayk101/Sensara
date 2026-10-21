# Sensara — AI-Powered Elder Care Monitoring - This won our team 1st place at KeanUHacks and Best Use of Eleven Labs AI
Real-time visual and audio safety monitoring for elderly care homes.

## The Problem
Care facilities are chronically understaffed. Caregivers are stretched thin across dozens of residents with different mobility limitations and fall-risk profiles. When a resident falls, wanders, or begins choking — they may not be able to reach a call button. Continuous manual surveillance is not feasible.

Sensara gives caregivers a real-time AI safety layer that monitors residents through a standard webcam and microphone with no specialized hardware required.

## What It Does
Sensara runs MediaPipe pose detection entirely in the browser, extracting 33 body landmarks per frame. It computes safety signals (posture angle, stillness duration, safe-zone position, hand placement) and classifies the resident's current state every frame. When a concern is detected, caregivers are alerted visually, by text-to-speech, SMS, and email — and every event is persisted to MongoDB Atlas for longitudinal history and analytics.

## Two Modes
**Multi-Feed Demo** — A simulated 4-camera care-home command center using prerecorded video files. Demonstrates how Sensara scales across multiple residents and rooms simultaneously, with a Facility Alert Panel showing a live sorted alert queue (Urgent first) with wait timers and save-to-history buttons.

**Live Camera Demo** — Full real-time webcam monitoring including pose skeleton overlay, draggable safe zone, audio distress detection, AI care guidance, and critical event video clip recording to S3.

## Detection Capabilities
| Detection | How It Works |
|---|---|
| Fall | Torso angle >50° and stillness >10s → Urgent |
| Immobility | No significant movement for >5 minutes → Assist |
| Wandering | Torso center exits safe zone for >3 continuous seconds → Watch |
| Unsafe posture | Torso angle >35° sustained for >3s → Watch/Assist |
| Choking (visual) | Hand near throat for ≥2 continuous seconds → Urgent |
| Audio distress | ElevenLabs transcribes mic; distress keywords trigger Urgent/Assist |
| Out of frame | Key landmarks not visible → Watch |

## Audio Distress Detection (ElevenLabs)
Sensara captures microphone input in 6-second chunks via the MediaRecorder API and sends each chunk to ElevenLabs `scribe_v2` for transcription and non-speech audio event detection. The resulting transcript is scanned for distress keywords (e.g. "help", "fall", "pain") and classified into a severity level — triggering an Urgent or Assist alert the same way visual pose detection would. If no API key is set, audio monitoring is disabled gracefully.

## Tech Stack
| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) + TypeScript |
| Styling | Tailwind CSS |
| Pose Detection | MediaPipe Pose Landmarker — runs entirely in-browser |
| Database | MongoDB Atlas |
| Video Storage | Amazon S3 |
| Video Capture | Browser MediaRecorder API |
| Audio STT | ElevenLabs scribe_v2 |
| SMS Alerts | Twilio Programmable Messaging |
| iMessage Alerts | Photon Spectrum |
| Email Alerts | Resend |
| AI Assistant | Anthropic Claude API (claude-haiku) |
| TTS Alerts | Web Speech API |

## MongoDB Atlas
Every detected safety event is stored as a document in real time. Collections: `safety_events`, `residents`, `caregiver_notes`, `video_clips`. Aggregation pipelines power 24-hour analytics and per-resident history. App runs fully in-memory demo mode if `MONGODB_URI` is not set.

## Run locally

Requires Node.js 22 or newer and npm. From the repository root:

```sh
cd elderwatch-ai
npm ci
npm run dev
```

Open the local URL printed by Next.js (normally http://127.0.0.1:3000). If another app is using that port, choose one explicitly:

```sh
npm run dev -- --port 3002
```

Press `Ctrl+C` in the server terminal to stop it. The server binds to the local machine only.

No credentials are required for the demo. The four video feeds, alert history, acknowledgements, caregiver notes, analytics, audio distress simulation, and mock assistant work locally. Demo data is held in memory and resets when the server restarts. Pause stops the demo videos and releases the live camera/microphone. Opening the Live Camera tab while monitoring is active requests camera permission. Pose detection downloads its model/WASM assets, so it requires an internet connection.

For optional services, copy the empty example and fill in only the credentials you intend to use, then restart the server:

```sh
cp .env.local.example .env.local
```

Run the copy command only if `.env.local` does not already exist; otherwise edit that file directly. The template contains no credentials.

MongoDB, S3 uploads/playback, ElevenLabs transcription, Anthropic responses, Twilio SMS, and Resend email require their respective settings in `.env.local`. Configuring SMS or email enables real outgoing urgent alerts. Keep this prototype local; it does not implement authentication.

## Photon iMessage alerts

Set `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, and `CAREGIVER_PHONE_NUMBER` in the private `elderwatch-ai/.env.local` file (or Railway Variables). Use an E.164 phone number and enroll that number in the Photon project's Users page. Restart the server after changing credentials. This uses Photon's hosted iMessage service; the recipient needs iMessage.

The dashboard shows configuration status and a **Test iMessage** button. Urgent camera and audio events send a short demo alert directing the recipient to the dashboard; resident names, recordings, and transcripts are not included. Duplicate alerts for the same resident/event are suppressed for two minutes, and test messages are limited to once a minute. These limits are per server process and reset on restart. Delivery failures do not block event saving. Background delivery is best effort on the persistent local/Railway server, without a durable queue or retries. A successful test means Photon accepted the message, not a device delivery receipt.

## Checks

```sh
npm run check       # ESLint, TypeScript, and regression tests
npm run build       # Production compilation
```

With the app running in demo mode and SMS/email unconfigured:

```sh
BASE_URL=http://127.0.0.1:3002 npm run test:smoke
```

The smoke test creates in-memory test events and checks persistence across API routes, acknowledgements, notes, history, fresh analytics, invalid input, audio simulation, assistant fallback, disabled storage responses, and all four video assets. Restart the server to clear test records. It does not exercise real camera/microphone input or cloud credentials.

To run a production build locally:

```sh
npm run build
npm start -- --port 3002
```

The Docker setup also includes the demo video/logo assets:

```sh
docker compose up --build
```

## Railway setup

The app uses its Dockerfile on Railway and does not require a Vercel account, token, or project link.

1. Connect this repository to a Railway service.
2. Set the service **Root Directory** to `/elderwatch-ai` and **Config File** to `/elderwatch-ai/railway.json`.
3. Leave the custom build and start commands unset. The Dockerfile builds the standalone Next.js server and starts it with `node server.js`, listening on `0.0.0.0` and the runtime `PORT`.
4. Add new integration credentials under the service's **Variables**, using the names in `elderwatch-ai/.env.local.example`. Local env files are excluded from Git and the Docker build context.

For a Railway MongoDB service, assign its connection URL to this app's `MONGODB_URI` variable and set `MONGODB_DB` to your chosen database. Without a URI, the app uses temporary in-memory demo data. S3 recording stays disabled until all four `AWS_*` settings in the template are supplied. Vercel credentials are not used.

See Railway's [Dockerfile guide](https://docs.railway.com/builds/dockerfiles) and [subdirectory configuration](https://docs.railway.com/deployments/monorepo). This prepares the repository; it does not create or deploy a Railway service.

## Maintenance notes

The app uses Next.js 15.5 with promise-based route parameters. The MediaPipe JavaScript package is pinned to the same version as its WASM runtime. Run `npm audit` when updating dependencies; remaining Tailwind 3/ESLint transitive advisories need separate dependency maintenance. Local verification does not establish clinical detection accuracy.
