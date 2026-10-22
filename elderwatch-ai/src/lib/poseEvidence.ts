import type { PoseLandmark, SafetyClassification, SafetySignals } from "./types";

export interface PoseFrame { time: number; landmarks: PoseLandmark[] | null }
export interface PoseObservation extends SafetyClassification {
  available: boolean;
  signals: SafetySignals;
  metrics: { torsoAngle: number; downwardShift: number; bothHandsNearNeck: boolean; samples: number };
}
// Engineering gates for this prototype, NOT medically validated thresholds.
// Evidence is measured in media seconds; pauses, seeks and missing frames cannot
// count toward a sustained condition. No rule depends on a clip name or offset.
export const POSE_POLICY = { version: "landmarks-v1", visibility: 0.5, maxGap: 0.8, windowSeconds: 12, fallHold: 0.8, gestureHold: 2, postureHold: 0.6 } as const;
const core = [11, 12, 23, 24];
const usable = (p: PoseLandmark | undefined): p is PoseLandmark => !!p && (p.visibility ?? 0) >= POSE_POLICY.visibility;
const midpoint = (a: PoseLandmark, b: PoseLandmark) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: { x: number; y: number }, b: { x: number; y: number }, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

export function analyzePoseWindow(frames: PoseFrame[], aspect = 16 / 9): PoseObservation {
  type TrackedPose = { time: number; shoulder: { x: number; y: number }; hip: { x: number; y: number }; torso: number; angle: number };
  let prior: TrackedPose | null = null;
  let upright: TrackedPose | null = null;
  let lastTime = -1, lowSince: number | null = null, gestureSince: number | null = null, leanSince: number | null = null, outsideSince: number | null = null;
  let fallTransition = false;
  let result: PoseObservation = unavailable();
  for (const frame of frames) {
    const lm = frame.landmarks;
    if (lastTime >= 0 && (frame.time <= lastTime || frame.time - lastTime > POSE_POLICY.maxGap)) {
      prior = null; upright = null; lowSince = gestureSince = leanSince = outsideSince = null; fallTransition = false;
    }
    lastTime = frame.time;
    if (!lm || !core.every(i => usable(lm[i]))) {
      prior = null; upright = null; lowSince = gestureSince = leanSince = outsideSince = null; fallTransition = false;
      result = unavailable(); continue;
    }
    const shoulder = midpoint(lm[11], lm[12]), hip = midpoint(lm[23], lm[24]);
    const torso = distance(shoulder, hip, aspect);
    if (torso < 0.04) { result = unavailable(); prior = upright = null; continue; }
    const angle = Math.atan2(Math.abs(shoulder.x - hip.x) * aspect, Math.abs(shoulder.y - hip.y)) * 180 / Math.PI;
    const low = angle >= 65;
    const shift = upright && frame.time - upright.time <= 3 ? (shoulder.y - upright.shoulder.y) / upright.torso : 0;
    if (low && shift > 0.35) fallTransition = true;
    if (low) lowSince ??= frame.time;
    else { lowSince = null; fallTransition = false; }
    // A new upright reference must not be captured halfway through a lean.
    if (angle < 30) upright = { time: frame.time, shoulder, hip, torso, angle };
    const neck = usable(lm[0]) ? { x: shoulder.x + .5 * (lm[0].x - shoulder.x), y: shoulder.y + .5 * (lm[0].y - shoulder.y) } : null;
    const shoulderWidth = distance(lm[11], lm[12], aspect);
    const near = (indices: number[]) => !!neck && indices.some(i => usable(lm[i]) && distance(lm[i], neck, aspect) < shoulderWidth * .6);
    const left = near([15, 19]), right = near([16, 20]);
    const both = left && right && angle < 60;
    if (both) gestureSince ??= frame.time; else gestureSince = null;
    if (angle > 35) leanSince ??= frame.time; else leanSince = null;
    const centerX = (shoulder.x + hip.x) / 2, inside = centerX >= .1 && centerX <= .9;
    if (!inside) outsideSince ??= frame.time; else outsideSince = null;
    const movement = prior ? Math.min(1, distance(hip, prior.hip, aspect) / Math.max(.01, frame.time - prior.time) / torso) : 1;
    const signals: SafetySignals = { visible: true, isLyingDown: low, postureAngle: angle, movementScore: movement, secondsStill: 0, insideSafeZone: inside,
      secondsLyingDown: lowSince === null ? 0 : frame.time - lowSince, secondsBadPosture: leanSince === null ? 0 : frame.time - leanSince,
      handsNearThroatSeconds: gestureSince === null ? 0 : frame.time - gestureSince, bothHandsNearThroat: both, leftHandNearThroat: left, rightHandNearThroat: right,
      secondsOutsideSafeZone: outsideSince === null ? 0 : frame.time - outsideSince };
    let classification: SafetyClassification = { severity: "stable", eventType: "normal", reason: "No configured movement warning detected", confidence: 0 };
    if (fallTransition && signals.secondsLyingDown! >= POSE_POLICY.fallHold) classification = { severity: "urgent", eventType: "possible_fall", reason: "Downward movement followed by a sustained horizontal torso — possible fall; check immediately", confidence: 0 };
    else if (signals.handsNearThroatSeconds! >= POSE_POLICY.gestureHold) classification = { severity: "urgent", eventType: "possible_choking", reason: "Sustained two-hand neck gesture — possible distress; check immediately. Video cannot confirm choking.", confidence: 0 };
    else if (signals.secondsOutsideSafeZone! >= 3) classification = { severity: "watch", eventType: "wandering", reason: "Tracked torso is outside the configured observation area", confidence: 0 };
    else if (signals.secondsBadPosture! >= POSE_POLICY.postureHold || left || right || low) classification = { severity: "watch", eventType: "unsafe_posture", reason: left || right ? "Hand near neck — observe and check; a gesture alone does not confirm choking" : "Leaning or horizontal posture — watching; a fall transition has not been established", confidence: 0 };
    result = { ...classification, available: true, signals, metrics: { torsoAngle: angle, downwardShift: shift, bothHandsNearNeck: both, samples: frames.length } };
    prior = { time: frame.time, shoulder, hip, torso, angle };
  }
  return result;
}
function unavailable(): PoseObservation {
  return { severity: "stable", eventType: "normal", reason: "Body tracking unavailable — cannot assess current movement", confidence: 0, available: false,
    signals: { visible: false, isLyingDown: false, postureAngle: 0, movementScore: 0, secondsStill: 0, insideSafeZone: true },
    metrics: { torsoAngle: 0, downwardShift: 0, bothHandsNearNeck: false, samples: 0 } };
}

/** Validate browser evidence before applying the same policy on the server. */
export function validatePoseFrames(value: unknown, videoTime: number): PoseFrame[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 80) throw new Error("Expected a bounded landmark window");
  let previous = -1;
  for (const row of value) {
    if (!row || typeof row.time !== "number" || !Number.isFinite(row.time) || row.time < 0 || row.time <= previous || row.time > videoTime + .1) throw new Error("Invalid landmark timing");
    previous = row.time;
    if (row.landmarks !== null && (!Array.isArray(row.landmarks) || row.landmarks.length !== 33 || row.landmarks.some((p: PoseLandmark) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 5 || Math.abs(p.y) > 5 || typeof p.visibility !== "number" || !Number.isFinite(p.visibility) || p.visibility < 0 || p.visibility > 1))) throw new Error("Invalid pose landmarks");
  }
  if (videoTime - previous > .8 || previous - value[0].time > POSE_POLICY.windowSeconds + .1) throw new Error("Stale landmark window");
  return value as PoseFrame[];
}
