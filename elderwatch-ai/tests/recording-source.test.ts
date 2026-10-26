import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startSession } from "../src/lib/platform/sessions";
import { submitIncident } from "../src/lib/platform/incidents";
import { prepareUpload, completeUpload } from "../src/lib/platform/uploads";
import { updateSettings } from "../src/lib/platform/settings";
import { clipObjectKey, recordingSource } from "../src/lib/clipPolicy";
import { saveResident } from "../src/lib/db/residents";
import { MOCK_RESIDENTS } from "../src/lib/mockData";
import { memory } from "../src/lib/platform/store";
import { pose } from "./fixtures/poseFrames";

beforeEach(async () => {
  delete process.env.MONGODB_URI;
  Object.assign(process.env, { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", S3_VIDEO_BUCKET: "test-clips" });
  await updateSettings({ recordingEnabled: true, voiceEnabled: false, notificationsEnabled: false });
});
const manual = (residentId: string) => ({ residentId, source: "manual", sourceEventId: randomUUID(), detectedAt: new Date().toISOString(), severity: "urgent", eventType: "possible_fall", confidence: .9, reason: "Test critical trigger" });

test("sessionless test and audio incidents cannot create live-camera uploads or spoof their origin", async () => {
  const resident = await saveResident({ ...MOCK_RESIDENTS[0], id: `source_${randomUUID()}` });
  for (const source of ["manual", "audio_monitor"]) {
    const event = await submitIncident({ ...manual(resident.id), source, recordingSource: "live_camera" });
    assert.equal(recordingSource(event), undefined);
    assert.equal(event.workflow?.video.status, "not_requested");
    assert.throws(() => clipObjectKey(event, "webm"), /camera recording source/);
    await assert.rejects(prepareUpload({ eventId: event._id, residentId: resident.id, contentType: "video/webm", fileSize: 100, source: "live_camera" }), /camera monitoring session/);
  }
});

test("the live-page Critical button derives its destination from the session and can record a new occurrence", async () => {
  const resident = await saveResident({ ...MOCK_RESIDENTS[0], id: `button_${randomUUID()}`, monitoringConfig: { recordingEnabled: true, audioEnabled: false } });
  const session = await startSession({ residentId: resident.id, source: "live_camera", deviceId: "camera", consent: true });
  const body = { ...manual(resident.id), sessionId: session.id, manualTrigger: true, recordingSource: "multi_feed_demo" };
  const event = await submitIncident(body);
  assert.equal(event.recordingSource, "live_camera");
  assert.equal(event.workflow?.video.status, "requested");
  assert.equal((await submitIncident(body))._id, event._id, "HTTP retries stay idempotent");
  const next = await submitIncident({ ...body, sourceEventId: randomUUID() });
  assert.notEqual(next._id, event._id, "A second button press must not reuse the old clip");
  const upload = await prepareUpload({ eventId: event._id, residentId: resident.id, contentType: "video/webm", fileSize: 100, source: "multi_feed_demo" });
  assert.match(upload.s3Key, /^critical-events\/live-camera\/[^/]+\.webm$/);
  memory("upload_intents").get(upload.uploadId)!.s3Key = "critical-events/demo/wrong.webm";
  await assert.rejects(completeUpload({ uploadId: upload.uploadId, eventId: event._id, residentId: resident.id }), /destination does not match/);
});

test("a demo Critical cannot absorb a live-camera Critical for the same patient", async () => {
  const residentId = "resident_001";
  const demo = await startSession({ residentId, source: "multi_feed_demo", deviceId: "feed1", consent: true });
  const live = await startSession({ residentId, source: "live_camera", deviceId: "camera", consent: true });
  const evidence = { residentId, aspect: 4 / 3, videoTime: 4, poseFrames: Array.from({ length: 21 }, (_, i) => ({ time: i * .2, landmarks: pose("neck") })) };
  const detect = (source: "live_camera" | "multi_feed_demo", sessionId: string) => submitIncident({ ...evidence, source, sessionId, scenarioId: "feed1", sourceEventId: randomUUID(), detectedAt: new Date().toISOString() });
  const demoEvent = await detect("multi_feed_demo", demo.id);
  const liveEvent = await detect("live_camera", live.id);
  assert.notEqual(liveEvent._id, demoEvent._id);
  assert.equal(liveEvent.source, "live_camera");
  assert.equal(demoEvent.source, "multi_feed_demo");
  assert.equal((await detect("multi_feed_demo", demo.id))._id, demoEvent._id);
  for (const event of [demoEvent, liveEvent]) {
    const upload = await prepareUpload({ eventId: event._id, residentId, contentType: "video/webm", fileSize: 100 });
    assert.ok(upload.s3Key.startsWith(event === demoEvent ? "critical-events/demo/residents/" : "critical-events/live-camera/"));
  }
});
