import { test } from "node:test";
import assert from "node:assert/strict";
import React, { createElement, useCallback, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import MultiFeedDemo from "../src/components/MultiFeedDemo";
import IncidentCenter from "../src/components/IncidentCenter";
import { GET as listEvents } from "../src/app/api/events/route";
import { createSafetyEvent, getRecentEvents, transitionIncident } from "../src/lib/db/events";
import { asActor } from "../src/lib/platform/auth";
import { MOCK_RESIDENTS, generateMockEvents } from "../src/lib/mockData";
import { pose } from "./fixtures/poseFrames";

test("Command Center counts current detections and retains notifications after recovery or pause", async t => {
  delete process.env.MONGODB_URI;
  process.env.LOCAL_DEMO_MODE = "true";
  const template = generateMockEvents()[0];
  const old = await createSafetyEvent({ ...template, residentName: "Earlier visit", status: "open" });
  const first = await createSafetyEvent({ ...template, source: "multi_feed_demo", residentId: "resident_002", residentName: "Current feed one", status: "open" });
  const second = await createSafetyEvent({ ...template, source: "multi_feed_demo", residentName: "Current feed two", status: "open" });
  const originals = ["React", "fetch", "window", "Worker"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const workers: WorkerStub[] = [];
  class WorkerStub {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { workers.push(this); }
    postMessage() {}
    terminate() {}
    emit(data: unknown) { this.onmessage?.({ data }); }
  }
  const requests: string[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/api/events?")) return listEvents(new Request(`http://localhost${url}`));
    if (url === "/api/notifications") return Response.json({ notifications: [] });
    if (url === "/api/monitoring-sessions") return Response.json({ id: JSON.parse(String(init?.body)).id });
    if (url.startsWith("/api/monitoring-sessions/")) return Response.json({ status: "ended" });
    if (url === "/api/observations") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.source, "multi_feed_demo");
      assert.ok(body.sessionId);
      return Response.json({ event: body.residentId === "resident_002" ? first : second });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  for (const [key, value] of Object.entries({ React, fetch: fetchMock, Worker: WorkerStub, window: { addEventListener() {}, removeEventListener() {} } })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.mock.timers.enable({ apis: ["setInterval"] });
  let renderer: ReactTestRenderer | undefined;
  function CommandCenter({ history = false }: { history?: boolean }) {
    const [running, setRunning] = useState<string[]>([]);
    const [incidents, setIncidents] = useState<Record<string, string | null>>({});
    const [historyIds, setHistoryIds] = useState<string[]>([]);
    const onIncident = useCallback((feedId: string, id: string | null) => {
      setIncidents(values => (values[feedId] ?? null) === id ? values : { ...values, [feedId]: id });
      if (id) setHistoryIds(values => values.includes(id) ? values : [...values, id]);
    }, []);
    const ids = running.flatMap(feedId => incidents[feedId] ? [incidents[feedId]!] : []);
    return createElement("div", null,
      createElement(MultiFeedDemo, { residents: MOCK_RESIDENTS, runningFeedIds: running, onToggleFeed: id => setRunning(values => values.includes(id) ? values.filter(value => value !== id) : [...values, id]), onIncident }),
      createElement(IncidentCenter, { eventIds: history ? undefined : historyIds, activeEventIds: history ? undefined : ids, showHistory: history, voiceEnabled: false }));
  }
  const count = () => renderer!.root.findByProps({ className: "open-count" }).children.join("");
  const names = () => renderer!.root.findAllByProps({ className: "incident-resident" }).map(node => node.children.join(""));
  const start = async (name: string, videoIndex: number) => {
    await act(async () => renderer!.root.findByProps({ "aria-label": `Play ${name} feed` }).props.onClick());
    const worker = workers.at(-1)!;
    await act(async () => {
      worker.emit({ type: "ready" });
      worker.emit({ type: "pose", time: 0, landmarks: pose("neck") });
      renderer!.root.findAllByType("video")[videoIndex].props.onPlaying();
    });
  };
  try {
    await act(async () => {
      renderer = create(createElement(CommandCenter), { createNodeMock: element => element.type === "video" ? {
        play: async () => {}, pause() {}, currentTime: 0, paused: true, readyState: 2, seeking: false,
        videoWidth: 640, videoHeight: 360, addEventListener() {}, removeEventListener() {},
      } : null });
    });
    assert.equal(count(), "0 open");
    assert.deepEqual(names(), []);
    assert.equal(requests.length, 0, "Paused feeds do not fetch or replay saved incidents");
    await start("Eleanor Brooks", 0);
    assert.equal(count(), "1 open");
    assert.deepEqual(names(), [first.residentName]);
    await start("Robert Hayes", 1);
    assert.equal(count(), "2 open");
    assert.deepEqual(new Set(names()), new Set([first.residentName, second.residentName]));
    await act(async () => workers[0].emit({ type: "pose", time: .2, landmarks: pose() }));
    assert.equal(count(), "1 open", "Normal evidence clears only that feed's active detection");
    assert.deepEqual(new Set(names()), new Set([first.residentName, second.residentName]), "Recovery reduces the count without removing notifications");
    await transitionIncident(second._id!, "resolved", "Test caregiver", "Reviewed");
    await act(async () => t.mock.timers.tick(3000));
    assert.equal(count(), "0 open", "Resolved incidents are excluded even while a detection is active");
    await act(async () => workers[0].emit({ type: "pose", time: .4, landmarks: pose("neck") }));
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(count(), "1 open", "A fresh detection can appear again after recovery");
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Pause Eleanor Brooks feed" }).props.onClick();
      renderer!.root.findByProps({ "aria-label": "Pause Robert Hayes feed" }).props.onClick();
    });
    assert.equal(count(), "0 open", "Paused feeds have no current detections");
    assert.deepEqual(new Set(names()), new Set([first.residentName, second.residentName]));
    await act(async () => renderer!.update(createElement(CommandCenter, { history: true })));
    assert.ok(names().includes(old.residentName), "Reports retains previous visits");
    assert.ok(names().includes(first.residentName), "Clearing a detection does not resolve or delete its saved incident");
    assert.equal(renderer!.root.findAllByProps({ className: "open-count" }).length, 0, "Reports does not display historical open totals as a live count");
    await act(async () => renderer!.update(createElement(CommandCenter)));
    assert.deepEqual(new Set(names()), new Set([first.residentName, second.residentName]), "Returning from Reports keeps only this visit's notifications");
    await act(async () => renderer!.update(createElement(CommandCenter, { key: "new-visit" })));
    assert.equal(count(), "0 open");
    assert.deepEqual(names(), [], "A new visit begins empty again");
  } finally {
    await act(async () => renderer?.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("incident ID queries validate inputs, retain patient access checks, and find older re-observed incidents", async () => {
  delete process.env.MONGODB_URI;
  process.env.LOCAL_DEMO_MODE = "true";
  const event = await createSafetyEvent({ ...generateMockEvents()[0], createdAt: "2020-01-01T00:00:00.000Z" });
  const request = (query: string) => listEvents(new Request(`http://localhost/api/events?${query}`));
  assert.deepEqual((await (await request("ids=")).json()).events, []);
  const result = await request(`limit=1&ids=${event._id}`);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).events[0]._id, event._id, "Filter IDs before applying the history limit");
  assert.equal((await request("ids=invalid")).status, 400);
  assert.equal((await request(`ids=${Array(101).fill(event._id).join(",")}`)).status, 400);
  await asActor({ id: "limited", name: "Limited", role: "caregiver", patientIds: [] }, async () => {
    assert.deepEqual(await getRecentEvents(100, [event._id!]), []);
  });
});
