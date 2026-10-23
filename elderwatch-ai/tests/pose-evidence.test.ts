import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePoseWindow, validatePoseFrames, type PoseFrame } from "../src/lib/poseEvidence";
import { measuredScenario, pose } from "./fixtures/poseFrames";
import { startSession } from "../src/lib/platform/sessions";
import { submitDetection } from "../src/lib/platform/incidents";
import { randomUUID } from "node:crypto";
import { monitoringState } from "../src/lib/platform/monitoring";
const frames = (kind: Parameters<typeof pose>[0], n = 31) => Array.from({ length: n }, (_, i) => ({ time: i * .2, landmarks: pose(kind) }));
test("leaning stays watching; lying without a measured transition never implies a fall", () => {
  assert.equal(analyzePoseWindow(frames("upright")).severity, "stable");
  assert.equal(analyzePoseWindow(frames("lean")).severity, "watch");
  assert.equal(analyzePoseWindow(frames("fallen")).severity, "watch");
  const fall = measuredScenario(0);
  assert.equal(analyzePoseWindow(fall.slice(0, 17)).severity, "watch");
  assert.equal(analyzePoseWindow(fall).severity, "urgent");
});
test("either hand near the neck escalates at three seconds; brief gestures remain watching", () => {
  assert.notEqual(analyzePoseWindow(frames("neck", 7)).severity, "urgent");
  assert.equal(analyzePoseWindow(frames("neck")).severity, "urgent");
  const one = frames("neck"); one.forEach(f => { f.landmarks[16].y = .7; f.landmarks[20].y = .7; });
  assert.equal(analyzePoseWindow(one.slice(0, 15)).severity, "watch");
  assert.equal(analyzePoseWindow(one.slice(0, 16)).severity, "urgent");
  assert.equal(analyzePoseWindow(one).eventType, "possible_choking");
});
test("missing landmarks, low visibility and sampling gaps cannot establish an urgent condition", () => {
  const missing: PoseFrame[] = [{ time: 0, landmarks: null }];
  assert.equal(analyzePoseWindow(missing).available, false);
  const occluded = frames("fallen"); occluded.forEach(f => f.landmarks[23].visibility = .1);
  assert.equal(analyzePoseWindow(occluded).available, false);
  const gap = measuredScenario(0); gap.forEach((f,i) => { if (i >= 15) f.time += 3; });
  assert.notEqual(analyzePoseWindow(gap).severity, "urgent");
});
test("leaving view becomes watching after one second of fresh absence and clears on return", () => {
  const present: PoseFrame[] = frames("upright", 5);
  const empty: PoseFrame[] = Array.from({ length: 66 }, (_, i) => ({ time: 1 + i * .2, landmarks: null }));
  assert.equal(analyzePoseWindow([...present, empty[0]]).available, false);
  const absent = analyzePoseWindow([...present, ...empty.slice(0, 6)]);
  assert.equal(absent.available, true);
  assert.equal(absent.severity, "watch");
  assert.equal(absent.eventType, "out_of_frame");
  assert.equal(absent.signals.visible, false);
  assert.equal(absent.signals.insideSafeZone, false);
  // Stay watching after the last visible person ages out of the rolling window.
  assert.equal(analyzePoseWindow(empty.slice(-60)).severity, "watch");
  assert.equal(analyzePoseWindow([...present, ...empty.slice(0, 6), { time: 2.2, landmarks: pose() }]).severity, "stable");
  assert.equal(analyzePoseWindow([]).available, false);
  assert.equal(analyzePoseWindow([{ time: 0, landmarks: null }, { time: 5, landmarks: null }]).available, false);
  assert.equal(analyzePoseWindow([{ time: 5, landmarks: null }, { time: 0, landmarks: null }]).available, false);
});

test("a sustained discontinuous furniture track watches without drawing a visible person", () => {
  const furniture = frames("upright", 12).map(f => ({ time: 1 + f.time, landmarks: f.landmarks.map(p => ({ ...p, x: p.x - .4 })) }));
  const result = analyzePoseWindow([...frames("upright", 5), ...furniture]);
  assert.equal(result.severity, "watch");
  assert.equal(result.available, true);
  assert.equal(result.signals.visible, false);
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
  const afterExit = wandering.map((frame, i) => ({ time: frame.time, result: analyzePoseWindow(wandering.slice(0, i + 1)) })).filter(row => row.time >= 11.8);
  assert.ok(afterExit.length > 0);
  assert.ok(afterExit.every(({ result }) => result.available && result.severity === "watch" && result.eventType === "out_of_frame" && !result.signals.visible));
});

test("server persists out-of-view evidence as WATCHING without urgent workflows", async () => {
  delete process.env.MONGODB_URI;
  const session = await startSession({ residentId: "resident_003", source: "multi_feed_demo", deviceId: "feed3", consent: true });
  const poseFrames: PoseFrame[] = Array.from({ length: 11 }, (_, i) => ({ time: i * .2, landmarks: null }));
  const event = await submitDetection({ residentId: "resident_003", source: "multi_feed_demo", scenarioId: "feed3", sessionId: session.id,
    sourceEventId: randomUUID(), detectedAt: new Date().toISOString(), videoTime: 2, poseFrames });
  assert.equal(event?.severity, "watch");
  assert.equal(event?.eventType, "out_of_frame");
  assert.equal(event?.workflow?.messaging.status, "disabled");
  assert.equal(event?.workflow?.video.status, "not_requested");
  assert.equal((await monitoringState()).find(p => p.patientId === "resident_003")?.observed, "WATCHING");
});

test("actual MediaPipe samples: neck gesture watches before three-second escalation", async () => {
  const { default: recorded } = await import("./fixtures/recorded-poses.json");
  const frames = recorded.choking as PoseFrame[];
  const results = frames.map((frame, i) => ({ time: frame.time, result: analyzePoseWindow(frames.slice(0, i + 1)) }));
  assert.ok(results.filter(r => r.time < 7).every(r => r.result.severity !== "urgent"));
  const firstUrgent = results.find(r => r.result.severity === "urgent");
  assert.equal(firstUrgent?.time.toFixed(1), "7.0");
  assert.ok(Math.abs(firstUrgent!.result.signals.handsNearThroatSeconds! - 3) < 1e-6);
});

test("one-hand neck gestures work with either hand, cropped hips and changes in framing", () => {
  for (const aspect of [4 / 3, 16 / 9]) for (const hand of [[15, 19], [16, 20]]) {
    const f = frames("upright", 51);
    f.forEach((frame, i) => {
      for (const index of hand) { frame.landmarks[index].x = .5; frame.landmarks[index].y = .23; }
      if (i % 2 === 0) { frame.landmarks[23].visibility = 0; frame.landmarks[24].visibility = 0; }
    });
    assert.equal(analyzePoseWindow(f.slice(0, 15), aspect).severity, "watch");
    assert.equal(analyzePoseWindow(f.slice(0, 16), aspect).severity, "urgent");
    assert.equal(analyzePoseWindow(f, aspect).eventType, "possible_choking");
    assert.equal(analyzePoseWindow(f, aspect).signals.bothHandsNearThroat, false);
  }
});

test("brief hand occlusion preserves prior evidence but missing time never advances the timer", () => {
  const f = frames("neck");
  for (const index of [15, 19, 16, 20]) f[6].landmarks[index].visibility = 0;
  assert.notEqual(analyzePoseWindow(f.slice(0, 7)).severity, "urgent");
  const recovered = analyzePoseWindow(f.slice(0, 17)); // 3.2 media seconds, 2.8 observed seconds.
  assert.equal(recovered.severity, "watch");
  assert.ok(Math.abs(recovered.signals.handsNearThroatSeconds! - 2.8) < 1e-6);
  assert.equal(analyzePoseWindow(f.slice(0, 18)).severity, "urgent");
  const longerLoss = frames("neck", 21);
  for (let i = 6; i <= 8; i++) longerLoss[i].landmarks.forEach(p => { p.visibility = 0; });
  assert.equal(analyzePoseWindow(longerLoss).severity, "watch");
});

test("lowering a hand, alternating brief gestures, off-screen points and sampling gaps cannot accumulate urgent evidence", () => {
  const lowered = frames("neck", 21);
  for (let i = 6; i <= 8; i++) lowered[i] = { time: i * .2, landmarks: pose() };
  assert.equal(analyzePoseWindow(lowered).severity, "watch");
  const alternating = frames("upright", 51);
  alternating.forEach((f, i) => { for (const j of (Math.floor(i / 5) % 2 ? [15, 19] : [16, 20])) { f.landmarks[j].x = .5; f.landmarks[j].y = .23; } });
  assert.equal(analyzePoseWindow(alternating).severity, "watch");
  const gap = frames("neck", 21); gap.forEach((f, i) => { if (i >= 7) f.time += 2; });
  assert.equal(analyzePoseWindow(gap).severity, "watch");
  for (const visibility of [0, .49, 1]) {
    const hidden = frames("neck");
    hidden.forEach(f => { for (const j of [15, 19, 16, 20]) { f.landmarks[j].visibility = visibility; if (visibility === 1) f.landmarks[j].x = -1; } });
    assert.notEqual(analyzePoseWindow(hidden).severity, "urgent");
  }
});

test("confirmed neck urgency survives boundary jitter and brief occlusion until a sustained visible release", () => {
  for (const cropped of [false, true]) {
    const f: PoseFrame[] = frames("neck", 31);
    if (cropped) f.forEach(frame => { frame.landmarks![23].visibility = 0; frame.landmarks![24].visibility = 0; });
    f[20].landmarks = pose(); // One noisy away frame after urgency has been established.
    f[25].landmarks = null;
    for (let i = 15; i < f.length; i++) {
      const result = analyzePoseWindow(f.slice(0, i + 1), 4 / 3);
      assert.equal(result.severity, "urgent", `frame ${i}, cropped=${cropped}`);
      assert.equal(result.available, true);
      if (i === 25) assert.equal(result.signals.visible, false, "Retained urgency must not invent visible landmarks");
    }
    const lowered = Array.from({ length: 6 }, (_, i) => ({ time: 6.2 + i * .2, landmarks: pose() }));
    assert.equal(analyzePoseWindow([...f, ...lowered.slice(0, 5)]).severity, "urgent");
    assert.equal(analyzePoseWindow([...f, ...lowered]).severity, "stable");
    assert.equal(analyzePoseWindow([...f, ...lowered, { time: 7.4, landmarks: pose("neck") }]).severity, "watch");
    const lost: PoseFrame[] = Array.from({ length: 4 }, (_, i) => ({ time: 6.2 + i * .2, landmarks: null }));
    assert.equal(analyzePoseWindow([...f, ...lost]).available, false, "Tracking loss cannot retain a current observation indefinitely");
  }
});

test("a long ongoing gesture with jitter stays urgent after the rolling evidence window advances", () => {
  const f: PoseFrame[] = frames("neck", 181);
  for (let i = 20; i < f.length; i += 9) f[i].landmarks = pose();
  for (let i = 15; i < f.length; i++) {
    const time = f[i].time;
    assert.equal(analyzePoseWindow(f.slice(0, i + 1).filter(frame => time - frame.time <= 12)).severity, "urgent", `media time ${time}`);
  }
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
