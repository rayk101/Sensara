import { test } from "node:test";
import assert from "node:assert/strict";
import { clipFileName, clipObjectKey, clipPolicy } from "../src/lib/clipPolicy";
import { completedRecording, recordingMetadata, type RecordingObject } from "../src/lib/platform/recordingMedia";
import { prepareUpload, completeUpload } from "../src/lib/platform/uploads";
import { createSafetyEvent, getSafetyEvent } from "../src/lib/db/events";
import { generateMockEvents } from "../src/lib/mockData";
import { updateSettings } from "../src/lib/platform/settings";
import { memory } from "../src/lib/platform/store";
import type { SafetyEvent } from "../src/lib/types";
import { assignLiveDetectionNumber } from "../src/lib/platform/liveDetectionNumbers";

test("critical clip names identify each demo patient and the live feed", () => {
  const base = { ...generateMockEvents()[0], firstUrgentAt: "2026-10-23T10:20:30.000Z" };
  for (const name of ["Eleanor Brooks", "Robert Hayes", "Margaret Chen", "Daniel Price"]) {
    const fileName = clipFileName({ ...base, source: "multi_feed_demo", residentName: name }, "mp4");
    assert.equal(fileName, `${name.toLowerCase().replace(/ /g, "-")}-2026-10-23T10-20-30-000Z.mp4`);
  }
  assert.equal(clipFileName({ ...base, source: "live_camera", liveDetectionNumber: 1 }, "webm"), "live-detection-1-2026-10-23T10-20-30-000Z.webm");
  assert.equal(clipFileName({ ...base, source: "live_camera", liveDetectionNumber: 2, criticalDetectedAt: "2026-10-23T10:20:29.500Z" }, "webm"), "live-detection-2-2026-10-23T10-20-29-500Z.webm");
  assert.ok(!clipFileName({ ...base, source: "multi_feed_demo", residentName: "../Bad/name" }, "mp4").includes("/"));
});

test("live recordings are flat and unique while demo folders stay unchanged", () => {
  const base = { ...generateMockEvents()[0], _id: "incident-one", residentName: "Eleanor Brooks", liveDetectionNumber: 1 };
  const key = clipObjectKey({ ...base, source: "live_camera" }, "mp4");
  assert.match(key, /^critical-events\/live-camera\/live-detection-1-[^/]+\.mp4$/);
  assert.equal(key.split("/").length, 3);
  assert.equal(clipObjectKey({ ...base, source: "multi_feed_demo" }, "mp4"), `critical-events/demo/residents/eleanor-brooks--resident_001/incident-one/${clipFileName({ ...base, source: "multi_feed_demo" }, "mp4")}`);
  assert.notEqual(key, clipObjectKey({ ...base, _id: "incident-two", liveDetectionNumber: 2, residentId: "resident_002", source: "live_camera" }, "mp4"));
  assert.throws(() => clipObjectKey({ ...base, source: "live_camera", liveDetectionNumber: undefined }, "mp4"), /detection number/);
  assert.throws(() => clipObjectKey({ ...base, _id: "../other" }, "mp4"));
});

for (const source of ["live_camera", "multi_feed_demo"] as const) {
  test(`${source}: upload policy verifies media duration, names the S3 object and links it once`, async () => {
    delete process.env.MONGODB_URI;
    // Local signing only. No request is made to these dummy S3 credentials.
    Object.assign(process.env, { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", S3_VIDEO_BUCKET: "test-clips" });
    await updateSettings({ recordingEnabled: true });
    const policy = clipPolicy(source);
    const start = new Date(Date.now() - 30_000).toISOString();
    const event: SafetyEvent = await createSafetyEvent({ ...generateMockEvents()[0], severity: "urgent", source,
      createdAt: start, firstUrgentAt: start, hasVideoClip: false, videoClipId: null, videoClip: null });
    const prepared = await prepareUpload({ eventId: event._id, residentId: event.residentId, contentType: "video/webm", fileSize: 100 });
    const numberedEvent = (await getSafetyEvent(event._id!))!;
    assert.ok(prepared.s3Key.endsWith(clipFileName(numberedEvent, "webm")));
    const request = { uploadId: prepared.uploadId, eventId: event._id, residentId: event.residentId,
      clipStartTime: start, clipEndTime: new Date(Date.parse(start) + policy.seconds * 1000).toISOString() };
    const inspect = async () => ({ size: 100, type: "video/webm", bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) });
    const wrongSeconds = source === "live_camera" ? 7 : 15;
    await assert.rejects(completeUpload({ ...request, clipEndTime: new Date(Date.parse(start) + wrongSeconds * 1000).toISOString(), source: source === "live_camera" ? "multi_feed_demo" : "live_camera" }, inspect, async () => wrongSeconds), /post-event footage/);
    await assert.rejects(completeUpload(request, inspect, async () => wrongSeconds), /complete.*clip/);
    let verified = 0;
    const verify = async (_key: string, limits = clipPolicy("live_camera")) => { verified++; assert.deepEqual(limits, policy); return policy.seconds; };
    const enhance = async (_intent: RecordingObject, _event: SafetyEvent, duration: number) => ({ durationSeconds: duration, recordedDurationSeconds: duration,
      fileSize: 200, contentType: "video/webm", hasAudioTrack: true, hasEmbeddedVoice: true, recordingFormatVersion: 2 });
    const saved = await completeUpload(request, inspect, verify, enhance);
    assert.equal(saved.durationSeconds, policy.seconds);
    assert.equal(saved.fileName, clipFileName(numberedEvent, "webm"));
    assert.equal(saved.event?.hasVideoClip, true);
    assert.equal(saved.event?.videoClip?.fileName, saved.fileName);
    assert.equal(saved.hasEmbeddedVoice, true);
    assert.equal(saved.hasAudioTrack, true);
    assert.equal(saved.fileSize, 200);
    assert.equal((await completeUpload(request, inspect, verify, enhance))._id, saved._id);
    assert.equal(verified, 1);
  });
}

test("concurrent preparation and retries reserve one stable number per live incident", async () => {
  delete process.env.MONGODB_URI;
  Object.assign(process.env, { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", S3_VIDEO_BUCKET: "test-clips" });
  await updateSettings({ recordingEnabled: true });
  const create = () => createSafetyEvent({ ...generateMockEvents()[0], source: "live_camera", hasVideoClip: false, createdAt: new Date().toISOString() });
  const first = await create(), second = await create();
  const prepare = (event: SafetyEvent) => prepareUpload({ eventId: event._id, residentId: event.residentId, contentType: "video/webm", fileSize: 100 });
  const attempts = await Promise.all(Array.from({ length: 8 }, () => prepare(first)));
  assert.equal(new Set(attempts.map(result => result.s3Key)).size, 1);
  assert.equal(new Set(attempts.map(result => result.uploadId)).size, 1);
  const firstNumber = (await getSafetyEvent(first._id!))!.liveDetectionNumber!;
  const secondUpload = await prepare(second);
  assert.equal((await getSafetyEvent(second._id!))!.liveDetectionNumber, firstNumber + 1);
  assert.notEqual(secondUpload.s3Key, attempts[0].s3Key);
  assert.equal((await assignLiveDetectionNumber(first)).liveDetectionNumber, firstNumber);
});

test("an already granted legacy upload keeps its original destination during deployment", async () => {
  delete process.env.MONGODB_URI;
  Object.assign(process.env, { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", S3_VIDEO_BUCKET: "test-clips" });
  const start = new Date(Date.now() - 20_000).toISOString();
  const event = await createSafetyEvent({ ...generateMockEvents()[0], source: "live_camera", createdAt: start, firstUrgentAt: start, hasVideoClip: false });
  const timestamp = start.replace(/[:.]/g, "-");
  const s3Key = `critical-events/live-camera/eleanor-brooks-${timestamp}--${event._id}.webm`;
  const intent = { id: "before-deployment", eventId: event._id, residentId: event.residentId, s3Key, bucket: "test-clips", contentType: "video/webm", fileSize: 100, status: "pending", createdAt: start, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  memory("upload_intents").set(intent.id, intent);
  const retry = await prepareUpload({ eventId: event._id, residentId: event.residentId, contentType: "video/webm", fileSize: 100 });
  assert.equal(retry.s3Key, s3Key);
  assert.equal((await getSafetyEvent(event._id!))?.liveDetectionNumber, undefined);
  const output = { durationSeconds: 15, recordedDurationSeconds: 15, fileSize: 200, contentType: "video/webm", hasAudioTrack: true, hasEmbeddedVoice: true, recordingFormatVersion: 2 };
  const saved = await completeUpload({ uploadId: retry.uploadId, eventId: event._id, residentId: event.residentId, clipStartTime: start, clipEndTime: new Date(Date.parse(start) + 15_000).toISOString() },
    async () => ({ size: 100, type: "video/webm", bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) }), async () => 15, async () => output);
  assert.equal(saved.s3Key, s3Key);
});

test("completed media recovery only trusts the server processing token", () => {
  const intent = { s3Key: "recording.webm", bucket: "test", fileSize: 100, contentType: "video/webm", processingToken: "private-token" };
  const output = { durationSeconds: 9, recordedDurationSeconds: 7, fileSize: 200, contentType: "video/webm", hasAudioTrack: true, hasEmbeddedVoice: true, recordingFormatVersion: 2 };
  const metadata = recordingMetadata(output, intent.processingToken);
  assert.deepEqual(completedRecording(metadata, intent), output);
  assert.equal(completedRecording(metadata, { ...intent, processingToken: "wrong" }), null);
  assert.equal(completedRecording(metadata, { ...intent, processingToken: undefined }), null);
});

test("completion recovers a processed S3 object after the database write was interrupted", async () => {
  delete process.env.MONGODB_URI;
  Object.assign(process.env, { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", S3_VIDEO_BUCKET: "test-clips" });
  const start = new Date(Date.now() - 30000).toISOString();
  const event = await createSafetyEvent({ ...generateMockEvents()[0], source: "multi_feed_demo", createdAt: start, firstUrgentAt: start, hasVideoClip: false });
  const prepared = await prepareUpload({ eventId: event._id, residentId: event.residentId, contentType: "video/webm", fileSize: 100 });
  const intent = memory("upload_intents").get(prepared.uploadId)!;
  const output = { durationSeconds: 10, recordedDurationSeconds: 7, fileSize: 200, contentType: "video/webm", hasAudioTrack: true, hasEmbeddedVoice: true, recordingFormatVersion: 2 };
  const metadata = recordingMetadata(output, intent.processingToken);
  const unexpected = async () => { throw new Error("Already-combined audio must not be mixed twice"); };
  const saved = await completeUpload({ uploadId: prepared.uploadId, eventId: event._id, residentId: event.residentId, clipStartTime: start,
    clipEndTime: new Date(Date.parse(start) + 7000).toISOString() }, async () => ({ size: 200, type: "video/webm", metadata }), unexpected, unexpected);
  assert.equal(saved.durationSeconds, 10); assert.equal(saved.recordedDurationSeconds, 7);
  assert.equal(saved.event?.hasVideoClip, true); assert.equal(saved.hasEmbeddedVoice, true);
});
