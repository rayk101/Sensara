import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePoseWindow, validatePoseFrames, type PoseFrame } from "../src/lib/poseEvidence";
import { measuredScenario, pose } from "./fixtures/poseFrames";
import { startSession } from "../src/lib/platform/sessions";
import { submitDetection } from "../src/lib/platform/incidents";
import { randomUUID } from "node:crypto";
const frames = (kind: Parameters<typeof pose>[0], n = 31) => Array.from({ length: n }, (_, i) => ({ time: i * .2, landmarks: pose(kind) }));
test("leaning stays watching; lying without a measured transition never implies a fall", () => {
  assert.equal(analyzePoseWindow(frames("upright")).severity, "stable");
  assert.equal(analyzePoseWindow(frames("lean")).severity, "watch");
  assert.equal(analyzePoseWindow(frames("fallen")).severity, "watch");
  const fall = measuredScenario(0);
  assert.equal(analyzePoseWindow(fall.slice(0, 17)).severity, "watch");
  assert.equal(analyzePoseWindow(fall).severity, "urgent");
});
test("a sustained two-hand gesture is needed; one hand or a brief gesture cannot trigger urgent", () => {
  assert.notEqual(analyzePoseWindow(frames("neck", 7)).severity, "urgent");
  assert.equal(analyzePoseWindow(frames("neck")).severity, "urgent");
  const one = frames("neck"); one.forEach(f => { f.landmarks[16].y = .7; f.landmarks[20].y = .7; });
  assert.equal(analyzePoseWindow(one).severity, "watch");
});
test("missing landmarks, low visibility and sampling gaps cannot establish an urgent condition", () => {
  const missing: PoseFrame[] = [{ time: 0, landmarks: null }];
  assert.equal(analyzePoseWindow(missing).available, false);
  const occluded = frames("fallen"); occluded.forEach(f => f.landmarks[23].visibility = .1);
  assert.equal(analyzePoseWindow(occluded).available, false);
  const gap = measuredScenario(0); gap.forEach((f,i) => { if (i >= 15) f.time += 3; });
  assert.notEqual(analyzePoseWindow(gap).severity, "urgent");
});
test("classification follows the landmark motion, not the absolute video timestamp", () => {
  const fall = measuredScenario(0);
  assert.equal(analyzePoseWindow(fall).severity, analyzePoseWindow(fall.map(f => ({ ...f, time: f.time + 100 }))).severity);
  assert.equal(analyzePoseWindow(frames("upright").map(f => ({ ...f, time: f.time + 100 }))).severity, "stable");
});
test("server validation rejects timer-only, stale, malformed and out-of-order evidence", async () => {
  assert.throws(() => validatePoseFrames(undefined, 10));
  assert.throws(() => validatePoseFrames(frames("upright"), 10));
  assert.throws(() => validatePoseFrames(frames("upright").reverse(), 6));
  const bad = frames("upright"); bad[2].landmarks[0].x = NaN;
  assert.throws(() => validatePoseFrames(bad, 6));
  delete process.env.MONGODB_URI;
  const session = await startSession({ residentId: "resident_001", source: "multi_feed_demo", deviceId: "feed1", consent: true });
  const request = { residentId: "resident_001", source: "multi_feed_demo", scenarioId: "feed1", sessionId: session.id, sourceEventId: randomUUID(), detectedAt: new Date().toISOString(), videoTime: 6, severity: "urgent", eventType: "possible_fall" };
  await assert.rejects(submitDetection(request), /body-tracking evidence/);
  assert.equal(await submitDetection({ ...request, poseFrames: frames("upright") }), null);
});
