import type { PoseLandmark, SafetyClassification, SafetySignals, SafeZone } from "./types";

export interface PoseFrame { time: number; landmarks: PoseLandmark[] | null }
export interface PoseObservation extends SafetyClassification {
  available: boolean;
  signals: SafetySignals;
  metrics: { torsoAngle: number; downwardShift: number; bothHandsNearNeck: boolean; samples: number };
}
// Engineering gates for this prototype, NOT medically validated thresholds.
// Evidence is measured in media seconds; pauses, seeks and missing frames cannot
// count toward a sustained condition. No rule depends on a clip name or offset.
export const POSE_POLICY = { version: "landmarks-v1", visibility: 0.5, maxGap: 0.8, windowSeconds: 12, absenceHold: 1, fallHold: 0.8, transitionWindow: 4, gestureHold: 2, postureHold: 0.6, slumpHold: 2, slumpAngle: 45 } as const;
const core = [11, 12, 23, 24];
const usable = (p: PoseLandmark | undefined): p is PoseLandmark => !!p && (p.visibility ?? 0) >= POSE_POLICY.visibility;
const inView = (p: PoseLandmark | undefined): p is PoseLandmark => usable(p) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const midpoint = (a: PoseLandmark, b: PoseLandmark) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: { x: number; y: number }, b: { x: number; y: number }, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

function neckGesture(lm: PoseLandmark[], aspect: number) {
  if (![0, 11, 12].every(i => usable(lm[i]))) return { left: false, right: false };
  const shoulder = midpoint(lm[11], lm[12]);
  const neck = { x: shoulder.x + .5 * (lm[0].x - shoulder.x), y: shoulder.y + .5 * (lm[0].y - shoulder.y) };
  const width = distance(lm[11], lm[12], aspect);
  const near = (indices: number[]) => indices.some(i => usable(lm[i]) && distance(lm[i], neck, aspect) < width * .6);
  return { left: near([15, 19]), right: near([16, 20]) };
}

// Both arms must be visibly extended downward, not merely inferred off-screen.
function armHanging(lm: PoseLandmark[], indices: [number, number, number], torso: number, aspect: number) {
  const [shoulder, elbow, wrist] = indices.map(i => lm[i]);
  if (![shoulder, elbow, wrist].every(p => usable(p) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return false;
  const ux = (shoulder.x - elbow.x) * aspect, uy = shoulder.y - elbow.y;
  const vx = (wrist.x - elbow.x) * aspect, vy = wrist.y - elbow.y;
  const length = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (length < .0001) return false;
  const elbowAngle = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / length))) * 180 / Math.PI;
  return elbowAngle >= 150 && elbow.y - shoulder.y > torso * .12 && wrist.y - elbow.y > torso * .12
    && Math.abs(wrist.x - shoulder.x) * aspect <= (wrist.y - shoulder.y) * .6;
}

export function analyzePoseWindow(frames: PoseFrame[], aspect = 16 / 9, safeZone?: SafeZone): PoseObservation {
  type TrackedPose = { time: number; shoulder: { x: number; y: number }; hip: { x: number; y: number }; torso: number; angle: number };
  let prior: TrackedPose | null = null;
  let upright: TrackedPose | null = null;
  let anchor: TrackedPose | null = null;
  let lastCoreTime = -1;
  let lastTime = -1, lowSince: number | null = null, gestureSince: number | null = null, leanSince: number | null = null, outsideSince: number | null = null;
  let slumpSince: number | null = null;
  let absentSince: number | null = null;
  // Only processed, consecutive video frames establish absence. No frames
  // (paused playback, loading or a failed worker) remain unavailable.
  const absent = (time: number): PoseObservation => {
    absentSince ??= time;
    const observation = unavailable();
    if (time - absentSince + 1e-6 < POSE_POLICY.absenceHold) return observation;
    return { ...observation, available: true, severity: "watch", eventType: "out_of_frame",
      reason: "Person out of view — not detected in the monitored area. Check their location.",
      signals: { ...observation.signals, insideSafeZone: false },
      metrics: { ...observation.metrics, samples: frames.length } };
  };
  let fallTransitionAt: number | null = null, fallConfirmed = false;
  let result: PoseObservation = unavailable();
  for (const frame of frames) {
    const lm = frame.landmarks;
    if (lastTime >= 0 && (frame.time <= lastTime || frame.time - lastTime > POSE_POLICY.maxGap)) {
      anchor = null; prior = null; upright = null; absentSince = null; slumpSince = lowSince = gestureSince = leanSince = outsideSince = null; fallTransitionAt = null; fallConfirmed = false;
    }
    lastTime = frame.time;
    if (!lm || !core.every(i => inView(lm[i]))) {
      prior = null; slumpSince = lowSince = leanSince = outsideSince = null;
      if (frame.time - lastCoreTime > POSE_POLICY.maxGap) { upright = null; fallTransitionAt = null; fallConfirmed = false; }
      result = unavailable();
      if (!lm || !core.some(i => inView(lm[i]))) result = absent(frame.time);
      else absentSince = null; // A partially visible person is not an empty room.
      const upperBodyVisible = lm && [0, 11, 12].every(i => inView(lm[i]));
      if (upperBodyVisible) result.reason = "Upper body only — include hips for posture/fall tracking and keep hands visible for gesture assessment.";
      // Upper-body gestures can be observed while the hips are out of view.
      // This never supplies fall or normal/full-body evidence.
      const { left, right } = upperBodyVisible ? neckGesture(lm, aspect) : { left: false, right: false };
      if (left && right) gestureSince ??= frame.time; else gestureSince = null;
      const held = gestureSince === null ? 0 : frame.time - gestureSince;
      if (left || right) result = { ...result, available: true,
        severity: held >= POSE_POLICY.gestureHold ? "urgent" : "watch",
        eventType: held >= POSE_POLICY.gestureHold ? "possible_choking" : "unsafe_posture",
        reason: held >= POSE_POLICY.gestureHold ? "Sustained two-hand neck gesture — possible distress; check immediately. Video cannot confirm choking. Full-body tracking unavailable." : "Hand near neck — watching. Full-body tracking unavailable; video cannot confirm choking.",
        signals: { ...result.signals, visible: true, leftHandNearThroat: left, rightHandNearThroat: right, bothHandsNearThroat: left && right, handsNearThroatSeconds: held },
        metrics: { ...result.metrics, bothHandsNearNeck: left && right, samples: frames.length } };
      continue;
    }
    lastCoreTime = frame.time;
    const shoulder = midpoint(lm[11], lm[12]), hip = midpoint(lm[23], lm[24]);
    const torso = distance(shoulder, hip, aspect);
    const angle = Math.atan2(Math.abs(shoulder.x - hip.x) * aspect, Math.abs(shoulder.y - hip.y)) * 180 / Math.PI;
    if (shoulder.y > hip.y && angle < 65) {
      result = absent(frame.time); prior = null; slumpSince = lowSince = gestureSince = leanSince = outsideSince = null; continue;
    }
    // Reject an abrupt switch to a different location (e.g. a chair mistaken
    // for a person after the tracked subject leaves). Reacquire near the last
    // credible position or reset on a new playback segment.
    if (anchor && distance(hip, anchor.hip, aspect) > Math.max(.15, anchor.torso * 1.5)) {
      prior = null; slumpSince = lowSince = gestureSince = leanSince = outsideSince = null;
      upright = null; fallTransitionAt = null; fallConfirmed = false;
      result = absent(frame.time);
      continue;
    }
    if (torso < 0.04) {
      // Foreshortening/occlusion is UNKNOWN, not a horizontal pose. Retain only
      // the recent measured transition; require new visible hold evidence.
      absentSince = null; result = unavailable(); prior = null; slumpSince = lowSince = gestureSince = leanSince = outsideSince = null; continue;
    }

    absentSince = null;

    const low = angle >= 65;
    const shift = upright && frame.time - upright.time <= POSE_POLICY.transitionWindow ? (shoulder.y - upright.shoulder.y) / upright.torso : 0;
    if (low && shift > 0.35) fallTransitionAt = frame.time;
    if (low) lowSince ??= frame.time;
    else lowSince = null;
    if (angle < 30) { fallTransitionAt = null; fallConfirmed = false; }
    if (low && lowSince !== null && frame.time - lowSince + 1e-6 >= POSE_POLICY.fallHold && fallTransitionAt !== null && frame.time - fallTransitionAt <= POSE_POLICY.transitionWindow) fallConfirmed = true;
    // A new upright reference must not be captured halfway through a lean.
    if (angle < 30) upright = { time: frame.time, shoulder, hip, torso, angle };
    const { left, right } = neckGesture(lm, aspect);
    const both = left && right && angle < 60;
    if (both) gestureSince ??= frame.time; else gestureSince = null;
    if (angle > 35) leanSince ??= frame.time; else leanSince = null;
    const centerX = (shoulder.x + hip.x) / 2, inside = centerX >= (safeZone?.x ?? .1) && centerX <= (safeZone ? safeZone.x + safeZone.width : .9);
    if (!inside) outsideSince ??= frame.time; else outsideSince = null;
    const bothArmsHanging = armHanging(lm, [11, 13, 15], torso, aspect) && armHanging(lm, [12, 14, 16], torso, aspect);
    const slumped = angle >= POSE_POLICY.slumpAngle && bothArmsHanging;
    if (slumped) slumpSince ??= frame.time; else slumpSince = null;
    const secondsSlumped = slumpSince === null ? 0 : frame.time - slumpSince;
    const movement = prior ? Math.min(1, distance(hip, prior.hip, aspect) / Math.max(.01, frame.time - prior.time) / torso) : 1;
    const signals: SafetySignals = { visible: true, isLyingDown: low, postureAngle: angle, movementScore: movement, secondsStill: 0, insideSafeZone: inside,
      bothArmsHanging, secondsSlumped,
      secondsLyingDown: lowSince === null ? 0 : frame.time - lowSince, secondsBadPosture: leanSince === null ? 0 : frame.time - leanSince,
      handsNearThroatSeconds: gestureSince === null ? 0 : frame.time - gestureSince, bothHandsNearThroat: both, leftHandNearThroat: left, rightHandNearThroat: right,
      secondsOutsideSafeZone: outsideSince === null ? 0 : frame.time - outsideSince };
    let classification: SafetyClassification = { severity: "stable", eventType: "normal", reason: "No configured movement warning detected", confidence: 0 };
    if (fallConfirmed && low) classification = { severity: "urgent", eventType: "possible_fall", reason: "Downward movement followed by a sustained horizontal torso — possible fall; check immediately", confidence: 0 };
    else if (signals.handsNearThroatSeconds! >= POSE_POLICY.gestureHold) classification = { severity: "urgent", eventType: "possible_choking", reason: "Sustained two-hand neck gesture — possible distress; check immediately. Video cannot confirm choking.", confidence: 0 };
    else if (secondsSlumped > POSE_POLICY.slumpHold + 1e-6) classification = { severity: "urgent", eventType: "unsafe_posture", reason: "Sustained slumped posture — torso deeply leaned with both arms hanging for more than 2 seconds; check immediately. Demo movement rule, not a diagnosis.", confidence: 0 };
    else if (signals.secondsOutsideSafeZone! >= 3) classification = { severity: "watch", eventType: "wandering", reason: "Tracked torso is outside the configured observation area", confidence: 0 };
    else if (slumped || signals.secondsBadPosture! >= POSE_POLICY.postureHold || left || right || low) classification = { severity: "watch", eventType: "unsafe_posture", reason: left || right ? "Hand near neck — observe and check; a gesture alone does not confirm choking" : "Leaning or horizontal posture — watching; a fall transition has not been established", confidence: 0 };
    result = { ...classification, available: true, signals, metrics: { torsoAngle: angle, downwardShift: shift, bothHandsNearNeck: both, samples: frames.length } };
    prior = { time: frame.time, shoulder, hip, torso, angle };
    anchor = prior;
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
