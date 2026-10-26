import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { submitDetection } from "../src/lib/platform/incidents";
import { startSession } from "../src/lib/platform/sessions";
import { saveResident } from "../src/lib/db/residents";
import { createSafetyEvent, getSafetyEvent, linkVideoClipToEvent } from "../src/lib/db/events";
import { MOCK_RESIDENTS, generateMockEvents } from "../src/lib/mockData";
import { pose } from "./fixtures/poseFrames";
import { prepareUpload } from "../src/lib/platform/uploads";
import { updateSettings } from "../src/lib/platform/settings";

test("yesterday's open incident and clip cannot suppress a fresh live Critical recording", async t => {
  delete process.env.MONGODB_URI;
  Object.assign(process.env, { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", S3_VIDEO_BUCKET: "test-clips" });
  await updateSettings({ recordingEnabled: true, voiceEnabled: false, notificationsEnabled: false });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const resident = await saveResident({ ...MOCK_RESIDENTS[0], monitoringConfig: { recordingEnabled: true, audioEnabled: false }, id: `repeat_${randomUUID()}` });
  const oldTime = new Date(Date.now() - 86400_000).toISOString();
  const old = await createSafetyEvent({ ...generateMockEvents()[0], residentId: resident.id, residentName: resident.name,
    source: "live_camera", sessionId: "yesterday", eventType: "possible_choking", severity: "urgent", status: "open",
    firstUrgentAt: oldTime, createdAt: oldTime, activeEpisodeKey: `${resident.id}:possible_choking` });
  await linkVideoClipToEvent(old._id!, "yesterdays-clip", { s3Key: "yesterday.webm", bucket: "test-clips", contentType: "video/webm", durationSeconds: 15, clipStartTime: oldTime, clipEndTime: oldTime });
  const session = await startSession({ residentId: resident.id, source: "live_camera", deviceId: "camera", consent: true });
  const input = (kind: "neck" | "upright", sessionId = session.id) => ({ source: "live_camera", residentId: resident.id, sessionId, aspect: 4 / 3, videoTime: 4,
    sourceEventId: randomUUID(), detectedAt: new Date().toISOString(), poseFrames: Array.from({ length: 21 }, (_, i) => ({ time: i * .2, landmarks: pose(kind) })) });
  const firstRequest = input("neck");
  const first = (await submitDetection(firstRequest))!;
  assert.notEqual(first._id, old._id);
  assert.equal(first.recurrenceOf, old._id);
  assert.equal(first.workflow?.video.status, "requested");
  assert.equal(first.hasVideoClip, false);
  assert.equal((await getSafetyEvent(old._id!))?.status, "open");
  assert.equal((await getSafetyEvent(old._id!))?.videoClipId, "yesterdays-clip");
  assert.equal((await submitDetection(firstRequest))?._id, first._id, "Retry must not create another occurrence");
  const upload = await prepareUpload({ eventId: first._id, residentId: resident.id, contentType: "video/webm", fileSize: 100 });
  assert.ok(upload.s3Key.startsWith("critical-events/live-camera/eleanor-brooks-"));
  assert.equal(upload.s3Key.split("/").length, 3);
  assert.ok(upload.s3Key.includes(first._id!));

  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(1000);
    assert.equal((await submitDetection(input("neck")))?._id, first._id, "Ongoing urgency must deduplicate");
  }
  const refresh = await startSession({ residentId: resident.id, source: "live_camera", deviceId: "camera", consent: true });
  assert.equal((await submitDetection(input("neck", refresh.id)))?._id, first._id, "Quick refresh does not repeat the alert");

  t.mock.timers.tick(1000);
  await submitDetection(input("upright"));
  t.mock.timers.tick(1000);
  assert.equal((await submitDetection(input("neck")))?._id, first._id, "One second of flicker is insufficient");
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); await submitDetection(input("upright")); }
  t.mock.timers.tick(1000);
  const requests = Array.from({ length: 5 }, () => input("neck"));
  const repeated = await Promise.all(requests.map(submitDetection));
  const next = repeated[0]!;
  assert.notEqual(next._id, first._id);
  assert.equal(new Set(repeated.map(e => e?._id)).size, 1);
  assert.equal(next.recurrenceOf, first._id);
  assert.equal(next.workflow?.video.status, "requested");
  assert.equal((await getSafetyEvent(first._id!))?.status, "open");
  const nextUpload = await prepareUpload({ eventId: next._id, residentId: resident.id, contentType: "video/webm", fileSize: 100 });
  assert.notEqual(nextUpload.s3Key, upload.s3Key);
});

test("missing tracking cannot rearm an ongoing Critical incident", async t => {
  delete process.env.MONGODB_URI;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const resident = await saveResident({ ...MOCK_RESIDENTS[0], monitoringConfig: { recordingEnabled: true, audioEnabled: false }, id: `loss_${randomUUID()}` });
  const session = await startSession({ residentId: resident.id, source: "live_camera", deviceId: "camera", consent: true });
  const observe = (missing: boolean) => submitDetection({ source: "live_camera", residentId: resident.id, sessionId: session.id, aspect: 4 / 3, videoTime: 4,
    sourceEventId: randomUUID(), detectedAt: new Date().toISOString(), poseFrames: Array.from({ length: 21 }, (_, i) => ({ time: i * .2, landmarks: missing ? null : pose("neck") })) });
  const original = await observe(false);
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(1000); await observe(true); }
  t.mock.timers.tick(1000);
  assert.equal((await observe(false))?._id, original?._id);
});
