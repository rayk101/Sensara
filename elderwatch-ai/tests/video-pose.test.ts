import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useVideoPose } from "../src/hooks/useVideoPose";
import { pose } from "./fixtures/poseFrames";

test("pausing releases the pose worker; late results cannot change the frozen observation", async () => {
  const original = globalThis.Worker;
  const workers: FakeWorker[] = [];
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    constructor() { workers.push(this); }
    postMessage() {}
    terminate() { this.terminated = true; }
    emit(data: unknown) { this.onmessage?.({ data }); }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const video = { currentTime: 0, paused: true, readyState: 2, seeking: false } as HTMLVideoElement;
  const ref = { current: video };
  let output!: ReturnType<typeof useVideoPose>, renderer: ReactTestRenderer | undefined;
  function Probe({ enabled }: { enabled: boolean }) { output = useVideoPose(ref, enabled); return null; }
  try {
    await act(async () => { renderer = create(createElement(Probe, { enabled: true })); });
    await act(async () => workers[0].emit({ type: "ready" }));
    await act(async () => workers[0].emit({ type: "pose", time: 0, landmarks: pose() }));
    assert.equal(output.observation.available, true);
    const observed = output.observation;
    await act(async () => renderer!.update(createElement(Probe, { enabled: false })));
    assert.equal(workers[0].terminated, true);
    await act(async () => workers[0].emit({ type: "pose", time: 1, landmarks: pose("fallen") }));
    assert.equal(output.observation, observed);
    assert.equal(output.status, "paused");
    await act(async () => renderer!.update(createElement(Probe, { enabled: true })));
    assert.equal(workers.length, 2);
    assert.equal(output.observation.available, false);
    await act(async () => workers[1].emit({ type: "error", message: "Tracking failed" }));
    assert.equal(output.observation.available, false);
    assert.equal(output.status, "error");
    assert.equal(workers[1].terminated, true);
  } finally { await act(async () => renderer?.unmount()); globalThis.Worker = original; }
});
