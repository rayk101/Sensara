import { test } from "node:test";
import assert from "node:assert/strict";
import React, { createElement, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import AudioMonitor from "../src/components/AudioMonitor";
import IncidentCenter from "../src/components/IncidentCenter";
import { MOCK_RESIDENTS } from "../src/lib/mockData";

function environment() {
  const originals = ["React", "navigator", "MediaRecorder", "Audio", "localStorage", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let stopped = 0, played = 0, paused = 0;
  let markPlayed!: () => void;
  const playbackStarted = new Promise<void>(resolve => { markPlayed = resolve; });
  let ended = () => {};
  const track = { stop: () => stopped++, addEventListener: (_: string, callback: () => void) => { ended = callback; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  let requestMic: () => Promise<MediaStream> = async () => stream;
  let resolveAnalysis: ((response: Response) => void) | undefined;
  let analysisSignal: AbortSignal | undefined;
  let recorderFails = false;
  const recorders: Recorder[] = [];
  class Recorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { if (recorderFails) throw new Error("Recorder unavailable"); recorders.push(this); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["a".repeat(600)]) }); this.onstop?.(); }
  }
  class Audio {
    src = "";
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    async play() { played++; markPlayed(); }
    pause() { paused++; }
  }
  const storage = new Map<string, string>();
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "/api/audio/analyze") {
      if (init?.method === "POST") {
        analysisSignal = init.signal as AbortSignal;
        return new Promise(resolve => { resolveAnalysis = resolve; });
      }
      return Response.json({ elevenLabsConfigured: true });
    }
    if (url.startsWith("/api/events?")) return Response.json({ events: [{
      _id: "audio-toggle-event", residentId: MOCK_RESIDENTS[0].id, residentName: MOCK_RESIDENTS[0].name,
      room: "Room 204", severity: "urgent", eventType: "possible_fall", reason: "Test observation",
      acknowledged: false, status: "open", workflow: { voice: { status: "ready" } },
    }] });
    if (url === "/api/notifications") return Response.json({ notifications: [] });
    if (url.endsWith("/voice")) return init?.method === "POST" ? new Response(new Blob(["test voice"])) : Response.json({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  };
  const globals = {
    React, MediaRecorder: Recorder, Audio, fetch: fetchMock,
    navigator: { mediaDevices: { getUserMedia: () => requestMic() }, locks: { request: async (_: string, _options: unknown, run: () => Promise<void>) => run() } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return {
    stream, recorders, playbackStarted, disconnect: () => ended(), setMic: (request: () => Promise<MediaStream>) => { requestMic = request; },
    failRecorder: () => { recorderFails = true; },
    get stopped() { return stopped; }, get played() { return played; }, get paused() { return paused; },
    get analysisSignal() { return analysisSignal; }, completeAnalysis: () => resolveAnalysis?.(Response.json({ event: { _id: "late-event" } })),
    restore: () => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

test("one switch starts microphone capture and spoken alerts; Off stops both and cancels pending analysis", { timeout: 2000 }, async () => {
  const env = environment();
  let renderer: ReactTestRenderer | undefined, savedEvents = 0;
  function Panel() {
    const [voiceEnabled, setVoiceEnabled] = useState(false);
    return createElement("div", null,
      createElement(AudioMonitor, { resident: MOCK_RESIDENTS[0], sessionId: "session", onMicStream: stream => setVoiceEnabled(!!stream), onEventSaved: () => savedEvents++ }),
      createElement(IncidentCenter, { voiceEnabled }));
  }
  try {
    await act(async () => { renderer = create(createElement(Panel)); });
    const toggle = () => renderer!.root.findByProps({ role: "switch" });
    assert.equal(toggle().props["aria-checked"], false);
    assert.equal(env.played, 0);
    await act(async () => toggle().props.onClick());
    await act(async () => { await env.playbackStarted; });
    assert.equal(toggle().props["aria-checked"], true);
    assert.equal(env.recorders[0].state, "recording");
    assert.equal(env.played, 1, "The same switch enables spoken alerts");
    await act(async () => env.recorders[0].stop());
    assert.equal(env.analysisSignal?.aborted, false);
    await act(async () => toggle().props.onClick());
    assert.equal(toggle().props["aria-checked"], false);
    assert.ok(env.stopped > 0);
    assert.ok(env.paused > 0, "Turning off interrupts voice playback");
    assert.equal(env.analysisSignal?.aborted, true);
    await act(async () => env.completeAnalysis());
    assert.equal(savedEvents, 0, "Late analysis cannot update a stopped monitor");
  } finally { await act(async () => renderer?.unmount()); env.restore(); }
});

test("cancelled or denied microphone permission never enables audio or voice", async () => {
  const env = environment();
  let renderer: ReactTestRenderer | undefined, resolveMic!: (stream: MediaStream) => void;
  const activeStreams: Array<MediaStream | null> = [];
  env.setMic(() => new Promise(resolve => { resolveMic = resolve; }));
  try {
    await act(async () => { renderer = create(createElement(AudioMonitor, { resident: MOCK_RESIDENTS[0], sessionId: "session", onMicStream: stream => activeStreams.push(stream) })); });
    const toggle = () => renderer!.root.findByProps({ role: "switch" });
    await act(async () => toggle().props.onClick());
    assert.equal(toggle().props["aria-busy"], true);
    await act(async () => toggle().props.onClick());
    await act(async () => resolveMic(env.stream));
    assert.equal(toggle().props["aria-checked"], false);
    assert.equal(env.stopped, 1);
    assert.equal(env.recorders.length, 0);
    env.setMic(async () => { throw new Error("Permission denied"); });
    await act(async () => toggle().props.onClick());
    assert.equal(toggle().props["aria-checked"], false);
    assert.equal(activeStreams.filter(Boolean).length, 0);
    assert.match(renderer!.root.findByProps({ role: "alert" }).children.join(""), /permission denied/);
  } finally { await act(async () => renderer?.unmount()); env.restore(); }
});

test("pausing, a lost microphone, and recorder failure all turn the switch off", async () => {
  const env = environment();
  let renderer: ReactTestRenderer | undefined, lastStream: MediaStream | null = null;
  const props = { resident: MOCK_RESIDENTS[0], sessionId: "session", onMicStream: (stream: MediaStream | null) => { lastStream = stream; } };
  try {
    await act(async () => { renderer = create(createElement(AudioMonitor, props)); });
    const toggle = () => renderer!.root.findByProps({ role: "switch" });
    await act(async () => toggle().props.onClick());
    assert.equal(lastStream, env.stream);
    await act(async () => renderer!.update(createElement(AudioMonitor, { ...props, isPaused: true })));
    assert.equal(lastStream, null);
    assert.equal(toggle().props["aria-checked"], false);
    assert.equal(toggle().props.disabled, true);
    await act(async () => renderer!.update(createElement(AudioMonitor, props)));
    await act(async () => toggle().props.onClick());
    await act(async () => env.disconnect());
    assert.equal(lastStream, null);
    assert.equal(toggle().props["aria-checked"], false);
    env.failRecorder();
    await act(async () => toggle().props.onClick());
    assert.equal(lastStream, null);
    assert.equal(toggle().props["aria-checked"], false);
    assert.match(renderer!.root.findByProps({ role: "alert" }).children.join(""), /Could not start audio recording/);
  } finally { await act(async () => renderer?.unmount()); env.restore(); }
});
