import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useResidentMonitor } from "../src/hooks/useResidentMonitor";
import { MOCK_RESIDENTS } from "../src/lib/mockData";
import type { PoseLandmark } from "../src/lib/types";

function uprightFrame(): PoseLandmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
  landmarks[0] = { x: 0.5, y: 0.1, z: 0, visibility: 1 };
  for (const index of [11, 12]) landmarks[index].y = 0.3;
  for (const index of [23, 24]) landmarks[index].y = 0.6;
  for (const index of [27, 28]) landmarks[index].y = 0.9;
  for (const index of [15, 16, 19, 20]) landmarks[index].y = 0.7;
  return landmarks;
}

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
