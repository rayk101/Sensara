import { test } from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import Dashboard from "../src/app/app/page";
import AudioMonitor from "../src/components/AudioMonitor";
import PoseCamera from "../src/components/PoseCamera";
import { GET as listEvents } from "../src/app/api/events/route";
import { POST as startSession } from "../src/app/api/monitoring-sessions/route";
import { createSafetyEvent } from "../src/lib/db/events";
import { submitDetection } from "../src/lib/platform/incidents";
import type { SafetyEvent } from "../src/lib/types";
import { MOCK_RESIDENTS, generateMockEvents } from "../src/lib/mockData";
import { pose } from "./fixtures/poseFrames";

test("Live Camera shows stable → watching → critical immediately, retains recovery history, and reports actual message status", async t => {
  delete process.env.MONGODB_URI;
  process.env.LOCAL_DEMO_MODE = "true";
  const template = { ...generateMockEvents()[0], status: "open" as const };
  const old = await createSafetyEvent({ ...template, reason: "Earlier camera visit" });
  const demo = await createSafetyEvent({ ...template, source: "multi_feed_demo", reason: "Demo-only incident" });
  const audio = await createSafetyEvent({ ...template, source: "audio_monitor", eventType: "audio_distress", reason: "Current audio detection" });
  const originals = ["React", "fetch", "window", "navigator", "Worker", "requestAnimationFrame", "cancelAnimationFrame", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const workers: WorkerStub[] = [];
  class WorkerStub {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { workers.push(this); }
    postMessage() {}
    terminate() {}
    emit(data: unknown) { this.onmessage?.({ data }); }
  }
  const track = { stop() {}, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
  const video = { srcObject: null, play: async () => {}, pause() {}, currentTime: 0, paused: true, readyState: 2, seeking: false,
    videoWidth: 640, videoHeight: 480, addEventListener() {}, removeEventListener() {} };
  let holdNext = false, releaseObservation: (() => void) | undefined;
  let critical: SafetyEvent | null = null, messageStatus = "queued";
  const requests: string[] = [], unexpected: string[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    if (url === "/api/residents") return Response.json({ residents: MOCK_RESIDENTS });
    if (url.startsWith("/api/events?")) return listEvents(new Request(`http://localhost${url}`));
    if (url === "/api/notifications") return Response.json({ notifications: critical ? [{ id: "sms-test", eventId: critical._id, residentId: critical.residentId, staffId: "test-caregiver", channel: "sms", status: messageStatus, error: null }] : [] });
    if (url === "/api/audio/analyze") return Response.json({ elevenLabsConfigured: false });
    if (url === "/api/video-clips/presign-upload") return Response.json({ s3Configured: false });
    if (url === "/api/monitoring-sessions") return startSession(new Request(`http://localhost${url}`, init));
    if (url.startsWith("/api/monitoring-sessions/")) return Response.json({ status: "ended" });
    if (url === "/api/observations") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.source, "live_camera");
      const event = await submitDetection(body);
      if (event?.severity === "urgent") critical = event;
      if (holdNext) { holdNext = false; return new Promise(resolve => { releaseObservation = () => resolve(Response.json({ event })); }); }
      return Response.json({ event });
    }
    unexpected.push(url);
    throw new Error(`Unexpected request: ${url}`);
  };
  const globals = {
    React, fetch: fetchMock, Worker: WorkerStub, window: { addEventListener() {}, removeEventListener() {} },
    navigator: { mediaDevices: { getUserMedia: async () => stream, enumerateDevices: async () => [] } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, localStorage: { getItem: () => null },
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  let renderer: ReactTestRenderer | undefined;
  const count = () => renderer!.root.findByProps({ className: "open-count" }).children.join("");
  const descriptions = () => renderer!.root.findAllByProps({ className: "incident-description" }).map(node => node.children.join(""));
  const badges = () => renderer!.root.findAll(node => typeof node.props.className === "string" && node.props.className.startsWith("incident-badge ")).map(node => node.children.join(""));
  const responseText = () => renderer!.root.findAllByProps({ className: "activity-response" }).flatMap(node => node.findAllByType("p").map(paragraph => paragraph.children.join("")));
  const tab = (name: string) => renderer!.root.findByProps({ className: "command-nav" }).findAllByType("button").find(node => node.children.join("") === name)!;
  const frame = async (time: number, kind: "upright" | "neck" = "neck") => {
    video.currentTime = time;
    await act(async () => {
      t.mock.timers.tick(200);
      workers.at(-1)!.emit({ type: "pose", time, landmarks: pose(kind) });
    });
  };
  try {
    await act(async () => { renderer = create(createElement(Dashboard), { createNodeMock: element => element.type === "video" ? video : null }); });
    await act(async () => tab("Live Camera").props.onClick());
    await act(async () => workers.at(-1)!.emit({ type: "ready" }));
    assert.equal(count(), "0 open");
    assert.deepEqual(descriptions(), [], "Loaded resident history must not populate live notifications");
    await frame(0, "upright");
    assert.equal(count(), "0 open", "Stable notifications do not increase the live count");
    assert.deepEqual(badges(), ["Stable"]);
    for (let i = 1; i <= 4; i++) await frame(i * .2, "upright");
    assert.deepEqual(badges(), ["Stable"], "Identical frames do not spam notifications");
    holdNext = true;
    await frame(1);
    assert.equal(count(), "1 open");
    assert.deepEqual(badges(), ["Watching", "Stable"], "The local transition appears before persistence responds");
    assert.match(descriptions()[0], /Hand near neck/);
    await act(async () => releaseObservation?.());
    for (let i = 6; i <= 22; i++) await frame(i * .2);
    assert.equal(renderer!.root.findByType(PoseCamera).props.severity, "urgent");
    assert.deepEqual(badges(), ["Critical", "Watching", "Stable"]);
    assert.equal(count(), "1 open", "Three timeline entries still represent one current detection");
    assert.match(responseText().join(""), /Immediate assistance needed/);
    assert.match(responseText().join(""), /SMS: queued/);
    messageStatus = "accepted";
    await act(async () => t.mock.timers.tick(3000));
    assert.match(responseText().join(""), /accepted by provider; delivery unconfirmed/);
    assert.doesNotMatch(responseText().join(""), /help is on the way|SMS: delivered/i);
    messageStatus = "delivered";
    await act(async () => t.mock.timers.tick(3000));
    assert.match(responseText().join(""), /SMS: delivered/);
    for (let i = 23; i <= 30; i++) await frame(i * .2, "upright");
    assert.equal(count(), "0 open");
    assert.deepEqual(badges(), ["Stable", "Critical", "Watching", "Stable"], "Recovery adds a stable update and retains the earlier transitions");
    await act(async () => {
      renderer!.root.findByType(AudioMonitor).props.onEventSaved(audio);
      renderer!.root.findByType(AudioMonitor).props.onObservation(audio);
    });
    assert.equal(count(), "1 open");
    assert.ok(descriptions().includes(audio.reason));
    const retained = descriptions();
    await act(async () => renderer!.root.findByProps({ "aria-label": "Pause camera" }).props.onClick());
    assert.equal(count(), "0 open", "Pausing clears the live count");
    assert.deepEqual(descriptions(), retained, "Pausing keeps notifications visible");
    await act(async () => tab("Command Center").props.onClick());
    assert.equal(count(), "0 open", "Live detections cannot populate the demo panel");
    await act(async () => tab("Reports").props.onClick());
    assert.ok(descriptions().includes(old.reason));
    assert.ok(descriptions().includes(demo.reason));
    assert.ok(descriptions().some(reason => /neck gesture/.test(reason)), "Saved camera incidents remain available in Reports");
    assert.equal(renderer!.root.findAllByProps({ className: "open-count" }).length, 0);
    await act(async () => tab("Live Camera").props.onClick());
    assert.deepEqual(descriptions(), retained, "Restarting preserves notifications and waits for fresh evidence before increasing the count");
    assert.equal(count(), "0 open");
    await act(async () => renderer!.update(createElement(Dashboard, { key: "fresh-visit" })));
    await act(async () => tab("Live Camera").props.onClick());
    assert.equal(count(), "0 open", "Reloading starts a fresh live panel");
    assert.deepEqual(descriptions(), []);
    assert.ok(requests.some(url => /ids=[a-f\d]{24}/.test(url)));
    assert.deepEqual(unexpected, [], "No recording, voice or messaging provider was called");
  } finally {
    await act(async () => renderer?.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
