import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { usePoseDetection, type PoseStatus } from "../src/hooks/usePoseDetection";
function environment(getUserMedia: () => Promise<unknown>) {
  const original = ["navigator", "cancelAnimationFrame", "requestAnimationFrame"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia } } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 1 });
  return () => { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
}
test("camera permission denial is unavailable, never an active safe observation", async () => {
  const restore = environment(async () => { throw new Error("NotAllowedError"); });
  let status: PoseStatus = "idle", message: string | null = null, renderer: ReactTestRenderer | undefined;
  function Probe() { const result = usePoseDetection(true); status = result.status; message = result.errorMessage; return createElement("video", { ref: result.videoRef }); }
  try { await act(async () => { renderer = create(createElement(Probe)); }); assert.equal(status, "no-webcam"); assert.match(message!, /unavailable/); }
  finally { await act(async () => renderer?.unmount()); restore(); }
});
test("patient switching releases a camera that arrives after the original session was cancelled", async () => {
  const pending: Array<(stream: unknown) => void> = [];
  const restore = environment(() => new Promise(resolve => pending.push(resolve)));
  let renderer: ReactTestRenderer | undefined, stopped = 0;
  function Probe({ patient }: { patient: string }) { const result = usePoseDetection(true, undefined, undefined, patient); return createElement("video", { ref: result.videoRef }); }
  try {
    await act(async () => { renderer = create(createElement(Probe, { patient: "original" })); });
    await act(async () => renderer!.update(createElement(Probe, { patient: "new" })));
    assert.equal(pending.length, 2);
    await act(async () => pending[0]({ getTracks: () => [{ stop: () => stopped++ }] }));
    assert.equal(stopped, 1);
    await act(async () => renderer?.unmount()); renderer = undefined;
    await act(async () => pending[1]({ getTracks: () => [{ stop: () => stopped++ }] }));
    assert.equal(stopped, 2);
  } finally { await act(async () => renderer?.unmount()); restore(); }
});
