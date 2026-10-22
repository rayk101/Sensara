import { measuredScenario, pose } from "./fixtures/poseFrames";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asActor, systemActor, requestActor, signSession, checkOrigin } from "../src/lib/platform/auth";
import { startSession } from "../src/lib/platform/sessions";
import { submitIncident } from "../src/lib/platform/incidents";
import { transitionIncident, getSafetyEvent, getRecentEvents } from "../src/lib/db/events";
import { saveResident, getResidentById } from "../src/lib/db/residents";
import { DEMO_SCENARIOS } from "../src/lib/demoScenarios";
import { MOCK_RESIDENTS } from "../src/lib/mockData";
import { memory } from "../src/lib/platform/store";
import { updateSettings, saveCaregiver } from "../src/lib/platform/settings";
import { enqueueNotifications, processNotifications, listNotifications, failurePolicy } from "../src/lib/platform/notifications";
import { validateClipFile } from "../src/lib/platform/uploads";
import { voiceText, generateSpeech } from "../src/lib/platform/voice";

beforeEach(() => { delete process.env.MONGODB_URI; });
async function fixture() {
  const id = `test_${randomUUID()}`;
  const patient = await saveResident({ ...MOCK_RESIDENTS[0], id });
  const session = await startSession({ residentId: id, source: "live_camera", deviceId: "test", consent: true });
  const body = { source: "manual", sessionId: session.id, residentId: id, severity: "urgent", eventType: "possible_fall", reason: "Fictional test", confidence: 0.9, sourceEventId: randomUUID(), detectedAt: new Date().toISOString() };
  return { patient, session, body };
}
test("all four video sources retain their trusted patient identities", () => {
  const names = ["Eleanor Brooks", "Robert Hayes", "Margaret Chen", "Daniel Price"];
  DEMO_SCENARIOS.forEach((scenario, i) => assert.equal(MOCK_RESIDENTS.find(p => p.id === scenario.residentId)?.name, names[i]));
});
test("concurrent retries and later frames share one authoritative active episode", async () => {
  const { body } = await fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => submitIncident(body)));
  assert.equal(new Set(results.map(e => e._id)).size, 1);
  const later = await submitIncident({ ...body, sourceEventId: randomUUID() });
  assert.equal(later._id, results[0]._id);
  assert.ok(later.workflow?.video); assert.ok(later.workflow?.voice); assert.ok(later.workflow?.messaging);
});
test("watch promotes to urgent once; reduced evidence cannot close an active incident", async () => {
  const { body } = await fixture();
  const watch = await submitIncident({ ...body, severity: "watch", eventType: "unsafe_posture" });
  assert.equal(watch.workflow?.video.status, "not_requested");
  const urgent = await submitIncident({ ...body, sourceEventId: randomUUID() });
  assert.equal(urgent._id, watch._id); assert.equal(urgent.severity, "urgent");
  const reduced = await submitIncident({ ...body, severity: "watch", eventType: "unsafe_posture", sourceEventId: randomUUID() });
  assert.equal(reduced.severity, "urgent"); assert.equal(reduced.status, "open");
});
test("acknowledgment is not resolution; terminal transitions require a reason and audit actor", async () => {
  const { body } = await fixture(); const e = await submitIncident(body);
  await assert.rejects(transitionIncident(e._id!, "resolved", "Caregiver", "Checked"));
  const results = await Promise.all([transitionIncident(e._id!, "acknowledged", "First"), transitionIncident(e._id!, "acknowledged", "Second")]);
  assert.equal(results[0]?.status, "acknowledged"); assert.equal(results[0]?.acknowledgedBy, "First");
  await assert.rejects(transitionIncident(e._id!, "resolved", "First"));
  const closed = await transitionIncident(e._id!, "resolved", "First", "Fictional scenario completed");
  assert.equal(closed?.status, "resolved"); assert.equal(closed?.stateHistory?.at(-1)?.reason, "Fictional scenario completed");
  await assert.rejects(transitionIncident(e._id!, "acknowledged", "Other"));
});
test("cross-patient reads and actions are denied and list results are scoped", async () => {
  const { body } = await fixture(); const e = await submitIncident(body);
  await asActor({ id: "limited", name: "Limited", role: "caregiver", patientIds: [] }, async () => {
    await assert.rejects(getSafetyEvent(e._id!)); await assert.rejects(transitionIncident(e._id!, "acknowledged"));
    assert.equal((await getRecentEvents()).length, 0);
  });
});
test("sessions reject wrong patient, missing consent, stale and out-of-order events", async () => {
  const { body, patient } = await fixture();
  await assert.rejects(startSession({ residentId: patient.id, source: "live_camera", deviceId: "test", consent: false }));
  await submitIncident(body);
  await assert.rejects(submitIncident({ ...body, sourceEventId: randomUUID(), detectedAt: new Date(Date.now() - 60_000).toISOString() }));
  const other = await fixture(); await assert.rejects(submitIncident({ ...body, residentId: other.patient.id }));
});
test("patient CRUD persists in demo store and inactive patients cannot start monitoring", async () => {
  const { patient } = await fixture();
  await saveResident({ room: "Room 999", active: false }, patient.id);
  assert.equal((await getResidentById(patient.id))?.room, "Room 999");
  await assert.rejects(startSession({ residentId: patient.id, source: "live_camera", deviceId: "test", consent: true }));
});
test("outbox routes assigned recipients, recovers saved intent, and never reruns accepted work", async () => {
  memory("notifications").clear();
  const { body, patient } = await fixture();
  await updateSettings({ notificationsEnabled: true, dataMode: "demo" });
  await saveCaregiver({ id: "assigned", name: "Assigned", active: true, urgentAlerts: true, channel: "imessage", destination: "+15551234567", patientIds: [patient.id] });
  await saveCaregiver({ id: "unassigned", name: "Unassigned", active: true, urgentAlerts: true, channel: "imessage", destination: "+15557654321", patientIds: [] });
  const e = await submitIncident(body);
  await enqueueNotifications(e); await enqueueNotifications(e);
  let sends = 0;
  await processNotifications(async n => { sends++; assert.equal(n.staffId, "assigned"); assert.equal(n.residentId, patient.id); return "provider-test-id"; });
  await processNotifications(async () => { sends++; return "duplicate"; });
  const notice = (await listNotifications()).find(n => n.eventId === e._id)!;
  assert.equal(sends, 1); assert.equal(notice.status, "accepted"); assert.notEqual(notice.status, "delivered");
});
test("provider timeouts remain unknown and unauthorized recipients are not retried", () => {
  assert.equal(failurePolicy({ name: "TimeoutError" }).uncertain, true);
  assert.equal(failurePolicy(new Error("Target not allowed for this project")).retry, false);
  assert.equal(failurePolicy({ status: 429 }).retry, true);
});
test("upload input validation rejects spoofed media types, empty and oversized files", () => {
  assert.throws(() => validateClipFile("text/html", 10)); assert.throws(() => validateClipFile("video/webm", 0));
  assert.throws(() => validateClipFile("video/webm", 60 * 1024 * 1024));
  assert.equal(validateClipFile("video/mp4", 100).extension, "mp4");
});
test("voice uses trusted incident identity and handles restricted keys without exposing errors", async t => {
  const { body } = await fixture(); const e = await submitIncident({ ...body, residentName: "Spoof", room: "Wrong" });
  assert.match(voiceText(e, true), /Eleanor Brooks/); assert.doesNotMatch(voiceText(e, true), /Spoof|Wrong/);
  assert.doesNotMatch(voiceText(e, false), /Eleanor/);
  const key = process.env.ELEVENLABS_API_KEY, voice = process.env.ELEVENLABS_VOICE_ID;
  process.env.ELEVENLABS_API_KEY = "test-only"; process.env.ELEVENLABS_VOICE_ID = "voice";
  t.after(() => { if (key) process.env.ELEVENLABS_API_KEY = key; else delete process.env.ELEVENLABS_API_KEY; if (voice) process.env.ELEVENLABS_VOICE_ID = voice; else delete process.env.ELEVENLABS_VOICE_ID; });
  t.mock.method(globalThis, "fetch", async () => new Response("secret provider payload", { status: 403 }));
  await assert.rejects(generateSpeech("Fictional alert"), error => error instanceof Error && /403/.test(error.message) && !/secret provider/.test(error.message));
});
test("authentication fails closed, session tampering and cross-site mutations are rejected", () => {
  const mode = process.env.LOCAL_DEMO_MODE; delete process.env.LOCAL_DEMO_MODE;
  try { assert.throws(() => requestActor(new Request("https://example.com/api/events"))); assert.throws(() => checkOrigin(new Request("https://example.com/api/events", { method: "POST", headers: { origin: "https://attacker.invalid" } }))); }
  finally { if (mode) process.env.LOCAL_DEMO_MODE = mode; }
});

test("fresh normal evidence uses recovery window; camera loss never clears active incidents", async t => {
  const { submitDetection } = await import("../src/lib/platform/incidents");
  const { monitoringState } = await import("../src/lib/platform/monitoring");
  const { updateSession } = await import("../src/lib/platform/sessions");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { body, patient, session } = await fixture();
  const normal = { ...body, source: "live_camera", videoTime: 6, aspect: 16 / 9, poseFrames: measuredScenario(1) };
  await submitIncident({ ...body, severity: "watch", eventType: "unsafe_posture" });
  const observe = () => submitDetection({ ...normal, sourceEventId: randomUUID(), detectedAt: new Date().toISOString() });
  await observe();
  assert.equal((await monitoringState()).find(p => p.patientId === patient.id)?.observed, "WATCHING");
  t.mock.timers.tick(6000); await observe();
  assert.equal((await monitoringState()).find(p => p.patientId === patient.id)?.observed, "NORMAL");
  await submitIncident({ ...body, sourceEventId: randomUUID(), detectedAt: new Date().toISOString() });
  await observe(); await updateSession(session.id, "interrupted");
  const state = (await monitoringState()).find(p => p.patientId === patient.id)!;
  assert.equal(state.health, "OFFLINE"); assert.equal(state.observed, "UNKNOWN"); assert.equal(state.priority, "URGENT");
});

test("closed camera episodes require normal evidence before rearming; refresh cannot send another initial alert", async t => {
  const { submitDetection } = await import("../src/lib/platform/incidents");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { body, patient } = await fixture();
  const input = { ...body, source: "live_camera", videoTime: 6, aspect: 16 / 9, poseFrames: measuredScenario(0) };
  const event = await submitIncident(input);
  const freshSession = await startSession({ residentId: patient.id, source: "live_camera", deviceId: "test", consent: true });
  const refresh = { ...input, sessionId: freshSession.id, sourceEventId: randomUUID() };
  assert.equal((await submitIncident(refresh))._id, event._id);
  await transitionIncident(event._id!, "acknowledged"); await transitionIncident(event._id!, "resolved", "Caregiver", "Fictional check complete");
  t.mock.timers.tick(1000);
  await assert.rejects(submitIncident({ ...refresh, sourceEventId: randomUUID(), detectedAt: new Date().toISOString() }));
  const normal = { ...refresh, poseFrames: measuredScenario(1) };
  await submitDetection({ ...normal, sourceEventId: randomUUID(), detectedAt: new Date().toISOString() });
  t.mock.timers.tick(6000);
  await submitDetection({ ...normal, sourceEventId: randomUUID(), detectedAt: new Date().toISOString() });
  const watching = await submitIncident({ ...refresh, poseFrames: measuredScenario(1).map(f => ({ ...f, landmarks: pose("lean") })), sourceEventId: randomUUID(), detectedAt: new Date().toISOString() });
  assert.equal(watching.severity, "watch");
  const next = await submitIncident({ ...refresh, sourceEventId: randomUUID(), detectedAt: new Date().toISOString() });
  assert.notEqual(next._id, event._id); assert.equal(next._id, watching._id); assert.equal(next.severity, "urgent");
});

test("closing one incident preserves another urgent priority and audit identities", async () => {
  const { monitoringState } = await import("../src/lib/platform/monitoring");
  const { body, patient } = await fixture();
  const first = await submitIncident(body);
  const second = await submitIncident({ ...body, eventType: "possible_choking", sourceEventId: randomUUID() });
  await transitionIncident(first._id!, "dismissed", "Caregiver", "Fictional duplicate concern");
  assert.equal((await monitoringState()).find(p => p.patientId === patient.id)?.priority, "URGENT");
  assert.equal(second.status, "open");
  assert.equal(first.stateHistory?.at(-1)?.actorId, "system");
});

test("browser playback is per device and delayed callbacks cannot regress completion", async t => {
  const { incidentSpeech, recordVoicePlayback } = await import("../src/lib/platform/voice");
  const { body } = await fixture(); const event = await submitIncident(body);
  process.env.ELEVENLABS_API_KEY = "test-only"; process.env.ELEVENLABS_VOICE_ID = "test-only";
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array([1, 2, 3])));
  await incidentSpeech(event._id!, "workstation-one");
  await recordVoicePlayback(event._id!, "blocked", "workstation-one");
  const key = `voice:${event._id}:system:workstation-one`;
  assert.equal(memory("notifications").get(key)?.generationStatus, "ready");
  assert.equal(memory("notifications").get(key)?.status, "blocked");
  await recordVoicePlayback(event._id!, "playing", "workstation-one");
  await recordVoicePlayback(event._id!, "played", "workstation-one");
  await recordVoicePlayback(event._id!, "playing", "workstation-one");
  assert.equal(memory("notifications").get(key)?.status, "played");
  await assert.rejects(recordVoicePlayback(event._id!, "played", "unregistered-device"));
  delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID;
});

test("video and voice failure leave the incident open and allow messaging to succeed independently", async t => {
  const { updateVideoState } = await import("../src/lib/platform/workflows");
  const { incidentSpeech } = await import("../src/lib/platform/voice");
  const { body, patient } = await fixture();
  memory("notifications").clear();
  await updateSettings({ notificationsEnabled: true, voiceEnabled: true });
  await saveCaregiver({ id: "isolation-recipient", name: "Fictional caregiver", channel: "imessage", destination: "+15551234567", patientIds: [patient.id], active: true, urgentAlerts: true });
  const event = await submitIncident(body);
  await updateVideoState(event._id!, "failed", "Synthetic S3 outage");
  process.env.ELEVENLABS_API_KEY = "test-only"; process.env.ELEVENLABS_VOICE_ID = "test-only";
  t.after(() => { delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID; });
  t.mock.method(globalThis, "fetch", async () => new Response("rejected", { status: 403 }));
  await assert.rejects(incidentSpeech(event._id!));
  await processNotifications(async () => "mock-accepted");
  assert.equal(event.status, "open"); assert.equal(event.workflow?.video.status, "failed");
  const notices = (await listNotifications()).filter(n => n.eventId === event._id);
  assert.equal(notices.find(n => n.channel === "voice")?.status, "failed");
  assert.equal(notices.find(n => n.channel === "imessage")?.status, "accepted");
});
