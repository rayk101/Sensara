import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useVideoRecorder } from "../src/hooks/useVideoRecorder";
import { generateMockEvents } from "../src/lib/mockData";
import type { SafetyEvent } from "../src/lib/types";

function setup(configured: boolean) {
  const originalFetch = globalThis.fetch;
  const originals = ["MediaStream", "MediaRecorder", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const ownedMicTrack = { kind: "audio", readyState: "live", stop() { this.readyState = "ended"; } };
  const cameraTrack = { kind: "video", readyState: "live", stop() { this.readyState = "ended"; } };
  let micRequests = 0;
  class Stream {
    constructor(private tracks: typeof cameraTrack[]) {}
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); }
  }
  const recorders: Recorder[] = [];
  class Recorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "video/webm";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    onerror?: () => void;
    constructor() { recorders.push(this); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["fake-video"]) });
      this.onstop?.();
    }
  }
  Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: Stream });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    mediaDevices: { async getUserMedia() { micRequests++; return new Stream([ownedMicTrack]); } },
  } });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ url, body });
    if (url.endsWith("presign-upload") && init?.method !== "POST") return Response.json({ s3Configured: configured });
    if (url.endsWith("presign-upload")) return Response.json({ uploadUrl: "https://example.invalid/upload", s3Key: "test.webm", bucket: "demo" });
    if (url.endsWith("/video-clips")) return Response.json({ _id: "clip", event: { ...body, _id: body.eventId, hasVideoClip: true } });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return {
    stream: new Stream([cameraTrack]) as unknown as MediaStream,
    requests, recorders, cameraTrack, ownedMicTrack,
    get micRequests() { return micRequests; },
    restore() {
      globalThis.fetch = originalFetch;
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const event = (): SafetyEvent => ({ ...generateMockEvents()[0], _id: "recording-event", createdAt: new Date().toISOString(), acknowledged: false });

test("disabled clip storage never requests the microphone or starts a recording", async () => {
  const env = setup(false);
  let renderer: ReactTestRenderer | undefined;
  let status = "";
  function Probe() {
    status = useVideoRecorder(env.stream, event(), null, false, () => {}).recordingStatus;
    return null;
  }
  try {
    await act(async () => { renderer = create(createElement(Probe)); });
    assert.equal(status, "s3-disabled");
    assert.equal(env.micRequests, 0);
    assert.equal(env.recorders.length, 0);
  } finally {
    await act(async () => renderer?.unmount());
    env.restore();
  }
});

test("an active clip retains its original event when later alerts arrive", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const env = setup(true);
  let renderer: ReactTestRenderer | undefined;
  const original = event();
  function Probe({ current }: { current: SafetyEvent }) {
    useVideoRecorder(env.stream, current, null, false, () => {});
    return null;
  }
  try {
    await act(async () => { renderer = create(createElement(Probe, { current: original })); });
    assert.equal(env.recorders.length, 1);
    await act(async () => renderer!.update(createElement(Probe, { current: { ...original, _id: "later-event", residentId: "other-resident", severity: "watch", eventType: "out_of_frame" } })));
    assert.equal(env.recorders[0].state, "recording");
    assert.equal(env.recorders.length, 1);
    t.mock.timers.tick(15_000);
    await act(async () => env.recorders[0].stop());
    const saved = env.requests.find(request => request.url === "/api/video-clips")?.body;
    assert.equal(saved?.eventId, original._id);
    assert.equal(saved?.residentId, original.residentId);
    assert.equal(saved?.hasAudioTrack, false);
    assert.equal(env.micRequests, 0);
    assert.equal(env.ownedMicTrack.readyState, "live");
    assert.equal(env.cameraTrack.readyState, "live");
  } finally {
    await act(async () => renderer?.unmount());
    env.restore();
  }
});

test("pausing cancels recording without taking microphone ownership or uploading partial footage", async () => {
  const env = setup(true);
  let renderer: ReactTestRenderer | undefined;
  const original = event();
  function Probe({ paused }: { paused: boolean }) {
    useVideoRecorder(env.stream, original, null, paused, () => {});
    return null;
  }
  try {
    await act(async () => { renderer = create(createElement(Probe, { paused: false })); });
    assert.equal(env.recorders[0].state, "recording");
    await act(async () => renderer!.update(createElement(Probe, { paused: true })));
    assert.equal(env.recorders[0].state, "inactive");
    assert.equal(env.ownedMicTrack.readyState, "live");
    assert.equal(env.requests.filter(request => request.url === "/api/video-clips").length, 0);
  } finally {
    await act(async () => renderer?.unmount());
    env.restore();
  }
});
