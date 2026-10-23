import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import React, { createElement, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import PoseCamera from "../src/components/PoseCamera";
import { useResidentMonitor } from "../src/hooks/useResidentMonitor";
import { DEFAULT_SAFE_ZONE } from "../src/lib/poseHelpers";
import { MOCK_RESIDENTS } from "../src/lib/mockData";
import { saveResident } from "../src/lib/db/residents";
import { startSession } from "../src/lib/platform/sessions";
import { submitDetection } from "../src/lib/platform/incidents";
import { monitoringState } from "../src/lib/platform/monitoring";
import type { PoseFrame } from "../src/lib/poseEvidence";
import { pose } from "./fixtures/poseFrames";

test("live one-hand gesture stays urgent on canvas and server through jitter across rolling windows", async () => {
  delete process.env.MONGODB_URI;
  const resident = await saveResident({ ...MOCK_RESIDENTS[0], id: `gesture_${randomUUID()}` });
  const session = await startSession({ residentId: resident.id, source: "live_camera", deviceId: "test-camera", consent: true });
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const startedAt = Date.now();
  let mediaTime = 0;
  Date.now = () => startedAt + mediaTime * 1000;
  // tsx uses classic JSX for the app's preserve setting; Next supplies its own runtime.
  const jsxGlobal = globalThis as typeof globalThis & { React?: typeof React };
  const originalReact = jsxGlobal.React;
  jsxGlobal.React = React;
  const originalRaf = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame;
  const draws = new Map<number, FrameRequestCallback>();
  let nextDraw = 0, renderer: ReactTestRenderer | undefined;
  const labels: string[] = [], errors: string[] = [];
  let sendFrame!: (frame: PoseFrame) => void;
  globalThis.requestAnimationFrame = callback => { draws.set(++nextDraw, callback); return nextDraw; };
  globalThis.cancelAnimationFrame = id => { draws.delete(id); };
  // Exercise the real server classifier with the hook's request; no external
  // database, camera, recording, provider calls or notification worker is used.
  globalThis.fetch = (async (url, init) => {
    if (url === "/api/observations") {
      try { return Response.json({ event: await submitDetection(JSON.parse(String(init?.body))) }); }
      catch (error) { errors.push(String(error)); return Response.json({ error: String(error) }, { status: 500 }); }
    }
    return Response.json({ events: [] });
  }) as typeof fetch;
  const context = new Proxy({ fillText: (label: string) => labels.push(label) }, {
    get: (target, key) => key in target ? Reflect.get(target, key) : () => {},
  });
  const video = { readyState: 2, videoWidth: 640, videoHeight: 480 };
  const canvas = { width: 640, height: 480, getContext: () => context };
  function Probe({ paused = false }: { paused?: boolean }) {
    const videoRef = useRef<HTMLVideoElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
    const [landmarks, setLandmarks] = useState<PoseFrame["landmarks"]>(null);
    const monitor = useResidentMonitor(resident, DEFAULT_SAFE_ZONE, { sessionId: session.id, isPaused: paused });
    sendFrame = frame => { setLandmarks(frame.landmarks); monitor.processFrame(frame.landmarks, { time: frame.time, aspect: 4 / 3 }); };
    return createElement(PoseCamera, { videoRef, canvasRef, landmarks, status: paused ? "idle" : "running", errorMessage: null,
      safeZone: DEFAULT_SAFE_ZONE, severity: monitor.classification.severity, observationAvailable: monitor.observationAvailable && !paused });
  }
  function draw() {
    labels.length = 0;
    for (const [id, callback] of [...draws]) { draws.delete(id); callback(0); }
    return labels.filter(label => label.startsWith("● "));
  }
  try {
    await act(async () => { renderer = create(createElement(Probe), { createNodeMock: element => element.type === "video" ? video : element.type === "canvas" ? canvas : null }); });
    for (let i = 0; i <= 180; i++) {
      mediaTime = i * .2;
      const landmarks = pose("neck");
      for (const index of [16, 20]) landmarks[index].y = .7;
      for (const index of [23, 24]) landmarks[index].visibility = 0;
      if (i >= 20 && i < 180 && i % 10 === 0) for (const index of [15, 19]) landmarks[index].y = .7;
      const brieflyMissing = i >= 20 && i % 10 === 5;
      await act(async () => sendFrame({ time: mediaTime, landmarks: brieflyMissing ? null : landmarks }));
      assert.deepEqual(draw(), [i < 15 ? "● WATCHING" : "● URGENT"], `media time ${mediaTime}`);
      if (i >= 15 && i % 5 === 0) assert.equal((await monitoringState()).find(p => p.patientId === resident.id)?.observed, "URGENT");
    }
    for (let i = 0; i <= 5; i++) {
      mediaTime = 36.2 + i * .2;
      await act(async () => sendFrame({ time: mediaTime, landmarks: pose() }));
      assert.deepEqual(draw(), [i < 5 ? "● URGENT" : "● STABLE"]);
    }
    assert.equal((await monitoringState()).find(p => p.patientId === resident.id)?.observed, "NORMAL");
    assert.deepEqual(errors, []);
    await act(async () => renderer!.update(createElement(Probe, { paused: true })));
    assert.deepEqual(draw(), []);
    await act(async () => renderer!.update(createElement(Probe, { paused: false })));
    const landmarks = pose("neck");
    mediaTime = 38;
    await act(async () => sendFrame({ time: mediaTime, landmarks }));
    assert.deepEqual(draw(), ["● WATCHING"], "Resuming must require a new hold, not retain prior urgent evidence");
  } finally {
    await act(async () => renderer?.unmount());
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    if (originalReact) jsxGlobal.React = originalReact; else Reflect.deleteProperty(jsxGlobal, "React");
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});
