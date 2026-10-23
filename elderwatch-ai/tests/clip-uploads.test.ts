import { test } from "node:test";
import assert from "node:assert/strict";
import { clipFileName, clipPolicy } from "../src/lib/clipPolicy";
import { prepareUpload, completeUpload } from "../src/lib/platform/uploads";
import { createSafetyEvent } from "../src/lib/db/events";
import { generateMockEvents } from "../src/lib/mockData";
import { updateSettings } from "../src/lib/platform/settings";
import type { SafetyEvent } from "../src/lib/types";

test("critical clip names identify each demo patient and the live feed", () => {
  const base = { ...generateMockEvents()[0], firstUrgentAt: "2026-10-23T10:20:30.000Z" };
  for (const name of ["Eleanor Brooks", "Robert Hayes", "Margaret Chen", "Daniel Price"]) {
    const fileName = clipFileName({ ...base, source: "multi_feed_demo", residentName: name }, "mp4");
    assert.equal(fileName, `${name.split(" ")[0].toLowerCase()}-2026-10-23T10-20-30-000Z.mp4`);
  }
  assert.equal(clipFileName({ ...base, source: "live_camera" }, "webm"), "live-feed-demo-2026-10-23T10-20-30-000Z.webm");
  assert.ok(!clipFileName({ ...base, source: "multi_feed_demo", residentName: "../Bad/name" }, "mp4").includes("/"));
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
    assert.ok(prepared.s3Key.endsWith(clipFileName(event, "webm")));
    const request = { uploadId: prepared.uploadId, eventId: event._id, residentId: event.residentId,
      clipStartTime: start, clipEndTime: new Date(Date.parse(start) + policy.seconds * 1000).toISOString() };
    const inspect = async () => ({ size: 100, type: "video/webm", bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) });
    const wrongSeconds = source === "live_camera" ? 7 : 15;
    await assert.rejects(completeUpload({ ...request, clipEndTime: new Date(Date.parse(start) + wrongSeconds * 1000).toISOString(), source: source === "live_camera" ? "multi_feed_demo" : "live_camera" }, inspect, async () => wrongSeconds), /post-event footage/);
    await assert.rejects(completeUpload(request, inspect, async () => wrongSeconds), /complete.*clip/);
    let verified = 0;
    const verify = async (_key: string, limits = clipPolicy("live_camera")) => { verified++; assert.deepEqual(limits, policy); return policy.seconds; };
    const saved = await completeUpload(request, inspect, verify);
    assert.equal(saved.durationSeconds, policy.seconds);
    assert.equal(saved.fileName, clipFileName(event, "webm"));
    assert.equal(saved.event?.hasVideoClip, true);
    assert.equal(saved.event?.videoClip?.fileName, saved.fileName);
    assert.equal((await completeUpload(request, inspect, verify))._id, saved._id);
    assert.equal(verified, 1);
  });
}
