import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { analyzePoseWindow, type PoseFrame } from "../src/lib/poseEvidence";
import { pose } from "./fixtures/poseFrames";
import { startSession } from "../src/lib/platform/sessions";
import { submitDetection } from "../src/lib/platform/incidents";
import { saveResident } from "../src/lib/db/residents";
import { MOCK_RESIDENTS } from "../src/lib/mockData";
import { updateSettings, saveCaregiver } from "../src/lib/platform/settings";

function hanging() {
  const p = pose();
  p[11] = { ...p[11], x: .27, y: .35 };
  p[12] = { ...p[12], x: .37, y: .35 };
  p[23] = { ...p[23], x: .55, y: .60 };
  p[24] = { ...p[24], x: .65, y: .60 };
  for (const [s, e, w] of [[11, 13, 15], [12, 14, 16]]) {
    p[e] = { ...p[e], x: p[s].x, y: .57 };
    p[w] = { ...p[w], x: p[s].x, y: .80 };
  }
  return p;
}
const sequence = (): PoseFrame[] => Array.from({ length: 17 }, (_, i) => ({ time: i * .2, landmarks: hanging() }));

test("slumped hanging-arm posture watches through two seconds and becomes urgent only after", () => {
  const f = sequence();
  assert.equal(analyzePoseWindow(f.slice(0, 10), 4/3).severity, "watch");
  assert.equal(analyzePoseWindow(f.slice(0, 11), 4/3).severity, "watch");
  const urgent = analyzePoseWindow(f.slice(0, 12), 4/3);
  assert.equal(urgent.severity, "urgent");
  assert.equal(urgent.eventType, "unsafe_posture");
  assert.equal(urgent.signals.bothArmsHanging, true);
  assert.match(urgent.reason, /Sustained slumped posture/);
});

test("ordinary reaching, standing with hanging arms, and one hanging arm do not escalate", () => {
  const upright = sequence(); upright.forEach(f => { f.landmarks![23].x = .27; f.landmarks![24].x = .37; });
  assert.notEqual(analyzePoseWindow(upright, 4/3).severity, "urgent");
  const reach = sequence(); reach.forEach(f => { f.landmarks![16].x = .7; f.landmarks![16].y = .4; });
  assert.notEqual(analyzePoseWindow(reach, 4/3).severity, "urgent");
  const bent = sequence(); bent.forEach(f => { f.landmarks![16].x = .6; f.landmarks![16].y = .58; });
  assert.notEqual(analyzePoseWindow(bent, 4/3).severity, "urgent");
});

test("missing, off-screen or low-confidence wrists cannot count as hanging arms", () => {
  for (const change of [(p: ReturnType<typeof hanging>) => { p[15].visibility = .2; }, (p: ReturnType<typeof hanging>) => { p[16].y = 1.2; }]) {
    const f = sequence(); f.forEach(frame => change(frame.landmarks!));
    assert.notEqual(analyzePoseWindow(f, 4/3).severity, "urgent");
    assert.equal(analyzePoseWindow(f, 4/3).signals.bothArmsHanging, false);
  }
});

test("occlusion, pose interruption and sampling gaps restart the two-second hold", () => {
  const hidden = sequence(); hidden[7].landmarks = null;
  assert.notEqual(analyzePoseWindow(hidden, 4/3).severity, "urgent");
  const moved = sequence(); moved[7].landmarks![16].y = .4;
  assert.notEqual(analyzePoseWindow(moved, 4/3).severity, "urgent");
  const gap = sequence(); gap.forEach((f, i) => { if (i >= 7) f.time += 2; });
  assert.notEqual(analyzePoseWindow(gap, 4/3).severity, "urgent");
});

test("server promotes one hanging-posture incident and starts independent urgent intents", async () => {
  delete process.env.MONGODB_URI;
  const id = `slump_${randomUUID()}`;
  await saveResident({ ...MOCK_RESIDENTS[0], id, monitoringConfig: { recordingEnabled: true, audioEnabled: false } });
  await saveCaregiver({ id: `staff_${id}`, name: "Fictional caregiver", active: true, urgentAlerts: true, channel: "imessage", destination: "+15551234567", patientIds: [id] });
  await updateSettings({ recordingEnabled: true, voiceEnabled: true, notificationsEnabled: true });
  const session = await startSession({ residentId: id, source: "live_camera", deviceId: "synthetic-camera", consent: true });
  const frames = sequence();
  const request = (n: number) => ({ residentId: id, source: "live_camera", sessionId: session.id, aspect: 4/3, videoTime: frames[n-1].time, poseFrames: frames.slice(0,n), sourceEventId: randomUUID(), detectedAt: new Date().toISOString() });
  const watching = await submitDetection(request(6));
  assert.equal(watching?.severity, "watch");
  const urgent = await submitDetection(request(12));
  assert.equal(urgent?._id, watching?._id);
  assert.equal(urgent?.severity, "urgent");
  assert.equal(urgent?.workflow?.video.status, "requested");
  assert.equal(urgent?.workflow?.voice.status, "queued");
  assert.equal(urgent?.workflow?.messaging.status, "queued");
  assert.deepEqual(urgent?.workflow?.messaging.recipientIds, [`staff_${id}`]);
  assert.equal((await submitDetection(request(17)))?._id, urgent?._id);
});
