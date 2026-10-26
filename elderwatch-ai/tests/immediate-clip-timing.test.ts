import { test } from "node:test";
import assert from "node:assert/strict";
import { createSafetyEvent } from "../src/lib/db/events";
import { generateMockEvents } from "../src/lib/mockData";
import { prepareUpload, completeUpload } from "../src/lib/platform/uploads";
import { updateSettings } from "../src/lib/platform/settings";

test("live footage starts at the client critical alert even when incident persistence arrives later", async () => {
  delete process.env.MONGODB_URI;
  Object.assign(process.env, { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", S3_VIDEO_BUCKET: "test-clips" });
  await updateSettings({ recordingEnabled: true });
  const criticalDetectedAt = new Date(Date.now() - 25_000).toISOString();
  const savedAt = new Date(Date.parse(criticalDetectedAt) + 4000).toISOString();
  const event = await createSafetyEvent({ ...generateMockEvents()[0], source: "live_camera", criticalDetectedAt, firstUrgentAt: savedAt,
    createdAt: savedAt, hasVideoClip: false, videoClipId: null, videoClip: null });
  const prepared = await prepareUpload({ eventId: event._id, residentId: event.residentId, contentType: "video/webm", fileSize: 100 });
  const input = { uploadId: prepared.uploadId, eventId: event._id, residentId: event.residentId,
    clipStartTime: criticalDetectedAt, clipEndTime: new Date(Date.parse(criticalDetectedAt) + 15_000).toISOString() };
  const inspect = async () => ({ size: 100, type: "video/webm", bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) });
  const enhance = async () => ({ durationSeconds: 15, recordedDurationSeconds: 15, fileSize: 200, contentType: "video/webm", hasAudioTrack: true, hasEmbeddedVoice: true, recordingFormatVersion: 2 });
  await assert.rejects(completeUpload({ ...input, clipStartTime: savedAt, clipEndTime: new Date(Date.parse(savedAt) + 15_000).toISOString() }, inspect, async () => 15, enhance), /must start at the critical alert/);
  const result = await completeUpload(input, inspect, async () => 15, enhance);
  assert.equal(result.footageType, "from-critical-alert");
  assert.equal(result.clipStartTime, criticalDetectedAt);
  assert.equal(result.hasEmbeddedVoice, true);
  assert.ok(result.fileName?.includes(criticalDetectedAt.replace(/[:.]/g, "-")));
});
