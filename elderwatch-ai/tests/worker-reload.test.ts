import { test } from "node:test";
import assert from "node:assert/strict";
import { startWorker } from "../src/lib/platform/worker";

test("worker restart discards the old timer and dispatches the current implementation", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const state = globalThis as typeof globalThis & { sensaraWorker?: ReturnType<typeof setInterval>; sensaraWorkerRun?: () => Promise<unknown>; sensaraWorkerBusy?: boolean };
  const original = state.sensaraWorkerRun;
  let stale = 0, current = 0;
  state.sensaraWorker = setInterval(() => { stale++; }, 3000);
  state.sensaraWorkerRun = async () => { current++; };
  try {
    startWorker();
    t.mock.timers.tick(3000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stale, 0); assert.equal(current, 1);
    state.sensaraWorkerRun = async () => { current += 10; };
    startWorker();
    t.mock.timers.tick(3000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(current, 11, "Only one timer should invoke the refreshed handler");
  } finally { clearInterval(state.sensaraWorker); delete state.sensaraWorker; state.sensaraWorkerRun = original; delete state.sensaraWorkerBusy; }
});
