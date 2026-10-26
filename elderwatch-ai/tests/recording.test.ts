import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useVideoRecorder } from "../src/hooks/useVideoRecorder";
import { generateMockEvents } from "../src/lib/mockData";
import type { SafetyEvent } from "../src/lib/types";

function setup(configured: boolean, completionDrops = 0, includeSourceAudio = false) {
  const originalFetch = globalThis.fetch;
  const originals = ["MediaStream", "MediaRecorder", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const ownedMicTrack = { kind: "audio", readyState: "live", stop() { this.readyState = "ended"; } };
  const cameraTrack = { kind: "video", readyState: "live", stop() { this.readyState = "ended"; } };
  const sourceAudioTrack = { kind: "audio", readyState: "live", stop() { this.readyState = "ended"; } };
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
    constructor(readonly stream: MediaStream) { recorders.push(this); }
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
    if (url.endsWith("presign-upload")) return Response.json({ uploadUrl: "https://example.invalid/upload", uploadId: "test-upload", headers: { "Content-Type": "video/webm", "If-None-Match": "*" }, s3Key: "test.webm", bucket: "demo" });
    if (url.endsWith("/video-clips")) {
      if (completionDrops-- > 0) throw new TypeError("Network response lost");
      return Response.json({ _id: "clip", event: { ...body, _id: body.eventId, hasVideoClip: true } });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return {
    stream: new Stream([cameraTrack, ...(includeSourceAudio ? [sourceAudioTrack] : [])]) as unknown as MediaStream,
    requests, recorders, cameraTrack, ownedMicTrack, sourceAudioTrack,
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

test("local Critical starts synchronously despite storage and persistence latency, then saves those same15seconds", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const env = setup(true, 0, true);
  const apiFetch = globalThis.fetch;
  let finishStorage!: (response: Response) => void;
  globalThis.fetch = ((url: string, init?: RequestInit) => url.endsWith("presign-upload") && !init?.method
    ? new Promise<Response>(resolve => { finishStorage = resolve; }) : apiFetch(url, init)) as typeof fetch;
  let renderer: ReactTestRenderer | undefined, recording!: ReturnType<typeof useVideoRecorder>;
  function Probe() { recording = useVideoRecorder(env.stream, null, null, false, () => {}, "live_camera"); return null; }
  try {
    await act(async () => { renderer = create(createElement(Probe)); });
    const trigger = { requestId: "immediate", residentId: event().residentId, detectedAt: new Date().toISOString() };
    await act(async () => {
      recording.beginLiveCapture(trigger);
      assert.equal(env.recorders[0]?.state, "recording", "No Promise or request precedes MediaRecorder.start");
    });
    await act(async () => { t.mock.timers.tick(15000); });
    assert.equal(env.recorders[0].state, "inactive");
    assert.equal(env.requests.filter(r => r.url === "/api/video-clips").length, 0, "Unconfirmed captures never upload");
    await act(async () => {
      t.mock.timers.tick(5000);
      finishStorage(Response.json({ s3Configured: true }));
      recording.bindLiveCapture(trigger.requestId, { ...event(), criticalDetectedAt: trigger.detectedAt });
    });
    const saved = env.requests.find(r => r.url === "/api/video-clips")?.body;
    assert.equal(saved?.clipStartTime, trigger.detectedAt);
    assert.equal(saved?.clipEndTime, new Date(Date.parse(trigger.detectedAt) + 15000).toISOString());
    assert.equal(saved?.hasAudioTrack, true);
    assert.equal(recording.recordingStatus, "saved");
    assert.equal(env.recorders.length, 1);
  } finally { await act(async () => renderer?.unmount()); env.restore(); }
});

test("rejected or interrupted local captures cannot upload after a late server response", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const env = setup(true);
  let renderer: ReactTestRenderer | undefined, recording!: ReturnType<typeof useVideoRecorder>;
  function Probe({ paused }: { paused: boolean }) { recording = useVideoRecorder(env.stream, null, null, paused, () => {}, "live_camera"); return null; }
  try {
    await act(async () => { renderer = create(createElement(Probe, { paused: false })); });
    const trigger = { requestId: "reject", residentId: event().residentId, detectedAt: new Date().toISOString() };
    await act(async () => { recording.beginLiveCapture(trigger); recording.bindLiveCapture(trigger.requestId, null); });
    assert.equal(env.recorders[0].state, "inactive");
    await act(async () => {
      recording.beginLiveCapture({ ...trigger, requestId: "pause" });
      renderer!.update(createElement(Probe, { paused: true }));
    });
    await act(async () => { t.mock.timers.tick(20000); recording.bindLiveCapture("pause", event()); });
    assert.ok(env.recorders.every(recorder => recorder.state === "inactive"));
    assert.equal(env.requests.filter(r => r.url === "https://example.invalid/upload").length, 0);
    assert.equal(env.cameraTrack.readyState, "live");
  } finally { await act(async () => renderer?.unmount()); env.restore(); }
});

test("the live camera recorder ignores demo and unrelated manual incidents", async () => {
  const env = setup(true);
  let renderer: ReactTestRenderer | undefined;
  let recording!: ReturnType<typeof useVideoRecorder>;
  function Probe({ current }: { current: SafetyEvent }) {
    recording = useVideoRecorder(env.stream, current, null, false, () => {}, "live_camera");
    return null;
  }
  try {
    await act(async () => { renderer = create(createElement(Probe, { current: { ...event(), source: "multi_feed_demo" } })); });
    await act(async () => renderer!.update(createElement(Probe, { current: { ...event(), _id: "unrelated", source: "manual" } })));
    assert.equal(env.recorders.length, 0);
    assert.ok(env.requests.every(request => request.url.endsWith("presign-upload") && !request.body));
    const manual: SafetyEvent = { ...event(), _id: "live-button", source: "manual", sessionId: "camera-session", recordingSource: "live_camera" };
    await act(async () => {
      recording.beginLiveCapture({ requestId: "local-button", residentId: manual.residentId, detectedAt: new Date().toISOString() });
      recording.bindLiveCapture("local-button", manual);
      renderer!.update(createElement(Probe, { current: manual }));
    });
    assert.equal(env.recorders.length, 1);
  } finally { await act(async () => renderer?.unmount()); env.restore(); }
});

test("recording keeps audio from the source video without opening a microphone", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const env = setup(true, 0, true);
  let renderer: ReactTestRenderer | undefined;
  function Probe() { useVideoRecorder(env.stream, event(), null, false, () => {}); return null; }
  try {
    await act(async () => { renderer = create(createElement(Probe)); });
    assert.deepEqual(env.recorders[0].stream.getAudioTracks(), [env.sourceAudioTrack]);
    await act(async () => { t.mock.timers.tick(15000); });
    assert.equal(env.requests.find(r => r.url === "/api/video-clips")?.body?.hasAudioTrack, true);
    assert.equal(env.micRequests, 0);
    assert.equal(env.sourceAudioTrack.readyState, "live");
  } finally { await act(async () => renderer?.unmount()); env.restore(); }
});

test("a lost completion response retries linking without recording or uploading twice", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const env = setup(true, 1);
  let renderer: ReactTestRenderer | undefined, status = "", saves = 0;
  function Probe() {
    status = useVideoRecorder(env.stream, event(), null, false, () => { saves++; }).recordingStatus;
    return null;
  }
  try {
    await act(async () => { renderer = create(createElement(Probe)); });
    await act(async () => { t.mock.timers.tick(15_000); });
    assert.equal(status, "uploading");
    await act(async () => { t.mock.timers.tick(500); });
    assert.equal(status, "saved");
    assert.equal(saves, 1);
    assert.equal(env.recorders.length, 1);
    assert.equal(env.requests.filter(r => r.url === "https://example.invalid/upload").length, 1);
    const completions = env.requests.filter(r => r.url === "/api/video-clips");
    assert.equal(completions.length, 2);
    assert.deepEqual(completions[0].body, completions[1].body);
  } finally {
    await act(async () => renderer?.unmount());
    env.restore();
  }
});

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

for (const [source, seconds] of [["live_camera", 15], ["multi_feed_demo", 7]] as const) {
  test(`${source}: a Watching incident promoted to Critical records ${seconds}s exactly once`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const env = setup(true);
    let renderer: ReactTestRenderer | undefined;
    const original = { ...event(), source, severity: "watch" as const };
    function Probe({ current }: { current: SafetyEvent }) {
      useVideoRecorder(env.stream, current, null, false, () => {});
      return null;
    }
    try {
      await act(async () => { renderer = create(createElement(Probe, { current: original })); });
      assert.equal(env.recorders.length, 0);
      const critical = { ...original, severity: "urgent" as const, firstUrgentAt: new Date().toISOString() };
      await act(async () => renderer!.update(createElement(Probe, { current: critical })));
      assert.equal(env.recorders.length, 1, "Escalation must trigger capture even though the ID is unchanged");
      await act(async () => { t.mock.timers.tick(seconds * 1000 - 1); });
      assert.equal(env.recorders[0].state, "recording");
      await act(async () => { t.mock.timers.tick(1); });
      assert.equal(env.recorders[0].state, "inactive");
      const saved = env.requests.find(request => request.url === "/api/video-clips")?.body;
      assert.equal(saved?.eventId, original._id);
      assert.equal((Date.parse(String(saved?.clipEndTime)) - Date.parse(String(saved?.clipStartTime))) / 1000, seconds);
      await act(async () => renderer!.update(createElement(Probe, { current: { ...critical } })));
      assert.equal(env.recorders.length, 1, "Repeated urgent samples must not duplicate a clip");
    } finally {
      await act(async () => renderer?.unmount());
      env.restore();
    }
  });
}
