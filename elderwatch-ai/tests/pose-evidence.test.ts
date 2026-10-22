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

test("actual MediaPipe samples: reaching is not urgent, down posture escalates only after transition evidence", async () => {
  const { default: recorded } = await import("./fixtures/recorded-poses.json");
  const fall = recorded.fall as PoseFrame[];
  const results = fall.map((frame, i) => ({ time: frame.time, result: analyzePoseWindow(fall.slice(0, i + 1)) }));
  assert.ok(results.filter(r => r.time < 9).every(r => r.result.severity !== "urgent"));
  assert.ok(results.some(r => r.time >= 7 && r.time < 9 && r.result.severity === "watch"));
  assert.ok(results.some(r => r.time >= 9 && r.time < 10.4 && !r.result.available));
  assert.equal(results.find(r => r.result.severity === "urgent")?.time.toFixed(1), "11.2");
  assert.equal(results.at(-1)?.result.eventType, "possible_fall");
});

test("actual MediaPipe samples: normal sitting/walking and leaving view never become urgent", async () => {
  const { default: recorded } = await import("./fixtures/recorded-poses.json");
  const stable = recorded.stable as PoseFrame[], wandering = recorded.wandering as PoseFrame[];
  assert.ok(stable.every((_, i) => analyzePoseWindow(stable.slice(0, i + 1)).severity === "stable"));
  assert.ok(wandering.every((_, i) => analyzePoseWindow(wandering.slice(0, i + 1)).severity !== "urgent"));
  assert.ok(wandering.some((_, i) => !analyzePoseWindow(wandering.slice(0, i + 1)).available));
});

test("actual MediaPipe samples: brief neck gesture watches before sustained two-hand escalation", async () => {
  const { default: recorded } = await import("./fixtures/recorded-poses.json");
  const frames = recorded.choking as PoseFrame[];
  const results = frames.map((frame, i) => ({ time: frame.time, result: analyzePoseWindow(frames.slice(0, i + 1)) }));
  assert.ok(results.filter(r => r.time < 7.8).every(r => r.result.severity !== "urgent"));
  assert.equal(results.find(r => r.result.severity === "urgent")?.time.toFixed(1), "7.8");
});

// Real-time browser sampling includes a brief occlusion during the descent.
test("actual live playback: reacquired low pose retains the recent upright transition", async () => {
  const { default: raw } = await import("./fixtures/live-fall-poses.json");
  const frames = raw as PoseFrame[];
  const results = frames.map((frame, i) => ({ time: frame.time, result: analyzePoseWindow(frames.slice(0, i + 1)) }));
  assert.ok(results.filter(r => r.time < 9).every(r => r.result.severity !== "urgent"));
  assert.ok(results.some(r => r.time > 9 && r.time < 10.2 && !r.result.available));
  assert.ok(results.some(r => r.time > 10.2 && r.result.eventType === "possible_fall" && r.result.severity === "urgent"));
});

test("upper-body neck gestures work without inventing full-body fall evidence", () => {
  const hands = frames("neck");
  hands.forEach(f => { f.landmarks[23].visibility = 0; f.landmarks[24].visibility = 0; });
  assert.equal(analyzePoseWindow(hands.slice(0, 4), 4/3).severity, "watch");
  assert.equal(analyzePoseWindow(hands, 4/3).eventType, "possible_choking");
  assert.equal(analyzePoseWindow(hands, 4/3).severity, "urgent");
  const hidden = frames("upright"); hidden.forEach(f => { f.landmarks[23].visibility = 0; f.landmarks[24].visibility = 0; });
  assert.equal(analyzePoseWindow(hidden, 4/3).available, false);
});

test("live camera uses the same server landmark policy and rejects signal-only escalation", async () => {
  delete process.env.MONGODB_URI;
  const session = await startSession({ residentId: "resident_002", source: "live_camera", deviceId: "camera-test", consent: true });
  const request = { residentId: "resident_002", source: "live_camera", sessionId: session.id, videoTime: 6, aspect: 4/3, sourceEventId: randomUUID(), detectedAt: new Date().toISOString() };
  await assert.rejects(submitDetection({ ...request, signals: { visible: true, handsNearThroatSeconds: 100 } }), /body-tracking evidence/);
  assert.equal(await submitDetection({ ...request, poseFrames: frames("upright"), severity: "urgent" }), null);
  const event = await submitDetection({ ...request, sourceEventId: randomUUID(), poseFrames: frames("neck") });
  assert.equal(event?.eventType, "possible_choking");
  assert.equal(event?.severity, "urgent");
  assert.equal(event?.detectionMethod, "mediapipe_pose_v1");
  assert.equal(event?.sessionId, session.id);
  assert.equal(event?.residentId, "resident_002");
});
