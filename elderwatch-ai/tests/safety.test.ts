import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyResidentSafety } from "../src/lib/classifySafety";
import { classifyAudioTranscript } from "../src/lib/elevenlabs";
import { clampSafeZone, DEFAULT_SAFE_ZONE, DETECTION_THRESHOLDS } from "../src/lib/poseHelpers";
import type { SafetySignals } from "../src/lib/types";

const baseline: SafetySignals = {
  visible: true, isLyingDown: false, movementScore: 0.2,
  postureAngle: 0, secondsStill: 0, insideSafeZone: true,
};

test("ordinary motion stays stable; lost tracking reports out of frame", () => {
  assert.equal(classifyResidentSafety(baseline).severity, "stable");
  assert.equal(classifyResidentSafety({ ...baseline, visible: false }).eventType, "out_of_frame");
});

test("fall classification requires sustained stillness", () => {
  const lying = { ...baseline, isLyingDown: true, movementScore: 0.01 };
  assert.notEqual(classifyResidentSafety({ ...lying, secondsStill: 9 }).eventType, "possible_fall");
  assert.equal(classifyResidentSafety({ ...lying, secondsStill: 11 }).eventType, "possible_fall");
});

test("wandering waits for the configured duration", () => {
  const outside = { ...baseline, insideSafeZone: false };
  assert.notEqual(classifyResidentSafety({ ...outside, secondsOutsideSafeZone: 1 }).eventType, "wandering");
  assert.equal(classifyResidentSafety({ ...outside, secondsOutsideSafeZone: 4 }).eventType, "wandering");
});

test("choking gestures must be sustained and upright", () => {
  const threshold = DETECTION_THRESHOLDS.chokingHandDurationSeconds;
  assert.notEqual(classifyResidentSafety({ ...baseline, handsNearThroatSeconds: threshold - 0.1 }).eventType, "possible_choking");
  assert.equal(classifyResidentSafety({ ...baseline, handsNearThroatSeconds: threshold }).eventType, "possible_choking");
  assert.notEqual(classifyResidentSafety({ ...baseline, isLyingDown: true, handsNearThroatSeconds: threshold }).eventType, "possible_choking");
});

test("experimental motion detection is disabled by default", () => {
  const motion = { ...baseline, movementScore: 0.95, majorBodyMovementScore: 0.95, secondsHighMovement: 8 };
  assert.notEqual(classifyResidentSafety(motion).eventType, "seizure_like_motion");
  assert.equal(classifyResidentSafety(motion, { seizureDetectionEnabled: true }).eventType, "seizure_like_motion");
});

test("audio simulation detects distress and silence stays stable", () => {
  assert.equal(classifyAudioTranscript("Help! I can't get up.", ["thud"]).severity, "urgent");
  assert.equal(classifyAudioTranscript("", []).severity, "stable");
});

test("safe zones stay finite and within the camera even for corrupt saved values", () => {
  for (const zone of [DEFAULT_SAFE_ZONE, { x: -1, y: 8, width: 4, height: -1 }, { x: NaN, y: 0, width: Infinity, height: 1 }]) {
    const result = clampSafeZone(zone);
    assert.ok(Number.isFinite(result.x) && Number.isFinite(result.width));
    assert.ok(result.x >= 0 && result.width >= 0.1 && result.x + result.width <= 1);
    assert.equal(result.y, 0);
    assert.equal(result.height, 1);
  }
});
