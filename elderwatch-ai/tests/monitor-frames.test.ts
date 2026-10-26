import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useResidentMonitor } from "../src/hooks/useResidentMonitor";
import { MOCK_RESIDENTS } from "../src/lib/mockData";
import type { PoseLandmark } from "../src/lib/types";
import { pose } from "./fixtures/poseFrames";
import { generateMockEvents } from "../src/lib/mockData";
import type { LiveCaptureTrigger } from "../src/hooks/useVideoRecorder";

function uprightFrame(): PoseLandmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  landmarks[0] = { x: 0.5, y: 0.1, z: 0, visibility: 1 };
  for (const index of [11, 12]) landmarks[index].y = 0.3;
  for (const index of [23, 24]) landmarks[index].y = 0.6;
  for (const index of [27, 28]) landmarks[index].y = 0.9;
  for (const index of [15, 16, 19, 20]) landmarks[index].y = 0.7;
  return landmarks;
}

for (const unmountBeforeReply of [false, true]) test(unmountBeforeReply
  ? "leaving the camera discards queued critical confirmations before they can persist"
  : "a local critical edge starts capture while an older observation is pending and preserves its original timestamp", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, unknown>> = [], captures: LiveCaptureTrigger[] = [], bindings: string[] = [];
  let finishFirst!: (response: Response) => void;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/events?")) return Response.json({ events: [] });
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (requests.length === 1) return new Promise<Response>(resolve => { finishFirst = resolve; });
    const event = { ...generateMockEvents()[0], _id: "confirmed", source: "live_camera", residentId: body.residentId, criticalDetectedAt: body.detectedAt };
    return Response.json(url === "/api/events" ? event : { event });
  }) as typeof fetch;
  let renderer: ReactTestRenderer | undefined, monitor!: ReturnType<typeof useResidentMonitor>;
  const resident = { ...MOCK_RESIDENTS[0], monitoringConfig: { recordingEnabled: true, audioEnabled: false } };
  function Probe() {
    monitor = useResidentMonitor(resident, undefined, {
      sessionId: "camera-session", onCriticalCapture: trigger => captures.push(trigger),
      onCriticalPersisted: (id, saved) => { if (saved) bindings.push(id); },
    }); return null;
  }
  try {
    await act(async () => { renderer = create(createElement(Probe)); });
    for (let frame = 0; frame <= 20; frame++) {
      await act(async () => { t.mock.timers.tick(200); monitor.processFrame(pose("neck"), { time: frame * .2, aspect: 4 / 3 }); });
    }
    assert.equal(requests.length, 1, "Earlier server request remains outstanding");
    assert.equal(captures.length, 1, "Local capture cannot wait for that request");
    const trigger = captures[0];
    await act(async () => { t.mock.timers.tick(100); monitor.injectDemoEvent(); });
    assert.equal(captures.length, 2, "The manual button also starts capture immediately");
    assert.equal(requests.length, 1, "The newer manual incident cannot overtake queued camera evidence");
    if (unmountBeforeReply) {
      await act(async () => { renderer!.unmount(); renderer = undefined; });
      await act(async () => finishFirst(Response.json({ event: null })));
      assert.equal(requests.length, 1, "Queued detections must not be submitted after the camera unmounts");
      assert.deepEqual(bindings, []);
      return;
    }
    await act(async () => { t.mock.timers.tick(3000); finishFirst(Response.json({ event: null })); });
    assert.equal(requests.length, 3);
    assert.equal(requests[1].sourceEventId, trigger.requestId);
    assert.equal(requests[1].detectedAt, trigger.detectedAt);
    assert.equal(requests[2].idempotencyKey, captures[1].requestId);
    assert.deepEqual(bindings, captures.map(c => c.requestId));
    assert.equal(monitor.latestEvent?._id, "confirmed");
  } finally { await act(async () => renderer?.unmount()); globalThis.fetch = originalFetch; }
});

test("continuous camera frames do not create an effect-driven second render", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ events: [] })) as typeof fetch;
  let renderer: ReactTestRenderer | undefined;
  let renders = 0;
  let sendFrame: (frame: PoseLandmark[]) => void = () => {};
  let visible = false;
  function Probe() {
    const [, setLandmarks] = useState<PoseLandmark[] | null>(null);
    const monitor = useResidentMonitor(MOCK_RESIDENTS[0]);
    renders++;
    sendFrame = frame => {
      setLandmarks(frame);
      monitor.processFrame(frame);
    };
    visible = monitor.signals.visible;
    return null;
  }
  try {
    await act(async () => { renderer = create(createElement(Probe)); });
    const initialRenders = renders;
    for (let frame = 0; frame < 240; frame++) {
      await act(async () => sendFrame(uprightFrame()));
    }
    assert.equal(visible, true);
    assert.equal(renders - initialRenders, 240, "Each frame should update landmarks and monitoring in the same render");
  } finally {
    await act(async () => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("pausing ignores queued camera frames and resuming still handles lost tracking", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ events: [] })) as typeof fetch;
  let renderer: ReactTestRenderer | undefined;
  let monitor: ReturnType<typeof useResidentMonitor> | undefined;
  function Probe({ paused }: { paused: boolean }) {
    monitor = useResidentMonitor(MOCK_RESIDENTS[0], undefined, { isPaused: paused });
    return null;
  }
  try {
    await act(async () => { renderer = create(createElement(Probe, { paused: false })); });
    await act(async () => monitor!.processFrame(uprightFrame()));
    assert.equal(monitor!.signals.visible, true);
    await act(async () => renderer!.update(createElement(Probe, { paused: true })));
    await act(async () => monitor!.processFrame(uprightFrame()));
    assert.equal(monitor!.signals.visible, false);
    assert.equal(monitor!.classification.reason, "Monitoring paused");
    await act(async () => renderer!.update(createElement(Probe, { paused: false })));
    await act(async () => monitor!.processFrame(uprightFrame()));
    assert.equal(monitor!.signals.visible, true);
    await act(async () => monitor!.processFrame(null));
    assert.equal(monitor!.signals.visible, false);
    assert.match(monitor!.classification.reason, /unavailable/);
  } finally {
    await act(async () => renderer?.unmount());
    globalThis.fetch = originalFetch;
  }
});
