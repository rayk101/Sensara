import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import ffmpeg from "ffmpeg-static";
import React, { createElement } from "react";
import RecordingNotice from "../src/components/RecordingNotice";
import { createSafetyEvent, getSafetyEvent, linkVideoClipToEvent } from "../src/lib/db/events";
import { generateMockEvents } from "../src/lib/mockData";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { inspectLocalMedia } from "../src/lib/platform/recordingMedia";
import { useVideoRecorder } from "../src/hooks/useVideoRecorder";
import { getS3Client } from "../src/lib/s3";
import { updateSettings } from "../src/lib/platform/settings";
import { measuredScenario } from "./fixtures/poseFrames";
import { POST as startSession } from "../src/app/api/monitoring-sessions/route";
import { POST as observe } from "../src/app/api/observations/route";
import { GET as storageStatus, POST as prepare } from "../src/app/api/video-clips/presign-upload/route";
import { POST as complete, GET as clips } from "../src/app/api/video-clips/route";
import { PATCH as capture } from "../src/app/api/events/[id]/capture/route";
import { GET as playback } from "../src/app/api/video-clips/[id]/playback-url/route";
import type { SafetyEvent } from "../src/lib/types";

test("Critical detection → recorder → authenticated upload APIs → decoded clip → playable incident", async t => {
  delete process.env.MONGODB_URI;
  Object.assign(process.env, { LOCAL_DEMO_MODE: "true", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", S3_VIDEO_BUCKET: "test-clips", ELEVENLABS_API_KEY: "test", ELEVENLABS_VOICE_ID: "test" });
  await updateSettings({ recordingEnabled: true, voiceEnabled: false, notificationsEnabled: false });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const directory = mkdtempSync(join(tmpdir(), "sensara-flow-test-"));
  const originalFetch = globalThis.fetch;
  const originals = ["MediaRecorder", "MediaStream", "React"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  const notices: string[] = [];
  const objects = new Map<string, { bytes: Uint8Array; type: string; metadata?: Record<string, string> }>();
  const etag = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const speechFile = join(directory, "speech.mp3");
  execFileSync(ffmpeg!, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=500:duration=9", speechFile]);
  const speechBytes = readFileSync(speechFile);
  const failures: string[] = [];
  let uploads = 0, fixture: Uint8Array, mimeType = "video/webm", renderer: ReactTestRenderer | undefined;
  let loseCompletionResponse = false, recoveredCompletions = 0;
  let savedEvent: SafetyEvent | null = null;
  let recording!: ReturnType<typeof useVideoRecorder>;
  const recorders: Recorder[] = [];
  class Stream {
    getVideoTracks() { return [{ kind: "video", readyState: "live" }]; }
    getAudioTracks() { return []; }
  }
  class Recorder {
    static isTypeSupported(type: string) { return type === mimeType; }
    state = "inactive";
    mimeType = mimeType;
    ondataavailable?: (e: { data: Blob }) => void;
    onstop?: () => void;
    constructor() { recorders.push(this); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([Uint8Array.from(fixture)], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: Stream });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: Recorder });
  const stream = new Stream() as unknown as MediaStream;
  // Replace only the hardware and object-storage transport. Classification,
  // recording lifecycle, authentication, upload validation, ffmpeg decoding,
  // persistence/linking and signed playback all execute their production code.
  t.mock.method(getS3Client(), "send", async (command: GetObjectCommand | HeadObjectCommand | PutObjectCommand) => {
    const object = objects.get(command.input.Key!);
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.IfMatch, object && etag(object.bytes));
      objects.set(command.input.Key!, { bytes: command.input.Body as Uint8Array, type: command.input.ContentType!, metadata: command.input.Metadata });
      return {};
    }
    if (!object) throw new Error("Object not uploaded");
    return { ContentLength: object.bytes.length, ContentType: object.type, ETag: etag(object.bytes), Metadata: object.metadata,
      ...(command instanceof GetObjectCommand ? { Body: { transformToByteArray: async () => command.input.Range ? object.bytes.slice(0, 32) : object.bytes } } : {}) };
  });
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const url = new URL(path, "http://localhost");
    if (url.hostname === "api.elevenlabs.io") return new Response(speechBytes, { headers: { "Content-Type": "audio/mpeg" } });
    if (url.hostname !== "localhost") {
      const key = decodeURIComponent(url.pathname.slice(1));
      if (init?.method === "PUT") {
        if (objects.has(key)) return new Response(null, { status: 412 });
        const blob = init.body as Blob;
        objects.set(key, { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type }); uploads++;
        return new Response(null, { status: 200 });
      }
      const object = objects.get(key);
      return object ? new Response(Uint8Array.from(object.bytes), { headers: { "Content-Type": object.type } }) : new Response(null, { status: 404 });
    }
    const request = new Request(url, init);
    let response: Response;
    if (url.pathname.endsWith("presign-upload")) response = await (init?.method === "POST" ? prepare(request) : (storageStatus as (req: Request) => Promise<Response>)(request));
    else if (url.pathname.endsWith("/capture")) response = await capture(request, { params: Promise.resolve({ id: url.pathname.split("/")[3] }) });
    else if (url.pathname === "/api/video-clips") {
      response = await complete(request);
      if (response.ok && loseCompletionResponse) {
        loseCompletionResponse = false; recoveredCompletions++;
        throw new TypeError("Connection lost after server committed the clip");
      }
    }
    else throw new Error(`Unexpected request: ${url.pathname}`);
    if (!response.ok) failures.push(`${url.pathname}: ${response.status} ${await response.clone().text()}`);
    return response;
  }) as typeof fetch;
  function Probe({ event }: { event: SafetyEvent }) {
    recording = useVideoRecorder(stream, event, null, false, saved => { savedEvent = saved; });
    if (recording.statusMessage) notices.push(recording.statusMessage);
    return createElement(RecordingNotice, { status: recording.recordingStatus, message: recording.statusMessage });
  }
  const request = (path: string, body: object) => new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    for (const [source, residentId, seconds, extension, codec] of [
      ["multi_feed_demo", "resident_001", 7, "webm", "libvpx-vp9"],
      ["live_camera", "resident_002", 15, "mp4", "libx264"],
    ] as const) {
      const file = join(directory, `synthetic.${extension}`);
      execFileSync(ffmpeg!, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x120:r=10", "-t", String(seconds), "-an", "-c:v", codec, "-pix_fmt", "yuv420p", file]);
      fixture = Uint8Array.from(readFileSync(file)); mimeType = `video/${extension}`; savedEvent = null;
      loseCompletionResponse = source === "live_camera";
      let previous: SafetyEvent | undefined;
      if (source === "live_camera") {
        const oldTime = new Date(Date.now() - 86400_000).toISOString();
        previous = await createSafetyEvent({ ...generateMockEvents()[0], residentId, source, sessionId: "yesterday",
          eventType: "possible_fall", severity: "urgent", status: "open", firstUrgentAt: oldTime, createdAt: oldTime,
          activeEpisodeKey: `${residentId}:fall` });
        await linkVideoClipToEvent(previous._id!, "previous-clip", { s3Key: "previous.mp4", bucket: "test-clips", contentType: "video/mp4", durationSeconds: 15, clipStartTime: oldTime, clipEndTime: oldTime });
      }
      const sessionResponse = await startSession(request("/api/monitoring-sessions", { residentId, source, deviceId: "feed1", consent: true }));
      assert.equal(sessionResponse.status, 201);
      const session = await sessionResponse.json();
      const frames = measuredScenario(0);
      const detection = async (count: number) => {
        const poseFrames = frames.slice(0, count);
        const response = await observe(request("/api/observations", { residentId, source, sessionId: session.id, scenarioId: "feed1", aspect: 16 / 9,
          sourceEventId: randomUUID(), detectedAt: new Date().toISOString(), videoTime: poseFrames.at(-1)!.time, poseFrames }));
        assert.equal(response.status, 200, await response.clone().text());
        return (await response.json()).event as SafetyEvent;
      };
      const watching = await detection(17);
      assert.equal(watching.severity, previous ? "urgent" : "watch");
      const before = recorders.length;
      await act(async () => { renderer = create(createElement(Probe, { event: watching })); });
      assert.equal(recorders.length, before);
      const critical = await detection(31);
      assert.equal(critical.severity, "urgent");
      if (previous) {
        assert.notEqual(critical._id, previous._id, "A previous open incident with a clip cannot suppress fresh capture");
        assert.equal(critical.recurrenceOf, previous._id);
      } else assert.equal(critical._id, watching._id);
      await act(async () => renderer!.update(createElement(Probe, { event: critical })));
      assert.equal(recording.recordingStatus, "capturing");
      assert.ok(JSON.stringify(renderer!.toJSON()).includes(`recording ${seconds} seconds`));
      assert.equal(renderer!.root.findByProps({ role: "status" }).props["aria-live"], "polite");
      assert.equal(recorders.length, before + 1);
      t.mock.timers.tick(seconds * 1000);
      await act(async () => {
        recorders.at(-1)!.stop();
        for (let n = 0; n < 300 && !savedEvent && !failures.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
      });
      assert.deepEqual(failures, []);
      assert.equal(recording.recordingStatus, "saved", recording.statusMessage ?? "");
      assert.ok(notices.includes("Saving clip to S3…"));
      assert.ok(JSON.stringify(renderer!.toJSON()).includes("Clip saved to S3:"));
      if (previous) {
        const preserved = await getSafetyEvent(previous._id!);
        assert.equal(preserved?.status, "open");
        assert.equal(preserved?.videoClipId, "previous-clip");
      }
      const saved = savedEvent as SafetyEvent | null;
      assert.ok(saved?.hasVideoClip);
      assert.equal(saved.workflow?.video.status, "available", "The returned incident must already show a playable clip");
      assert.ok(saved.videoClip!.durationSeconds >= seconds - .2);
      assert.ok(saved.videoClip!.durationSeconds >= 9);
      assert.ok(Math.abs(saved.videoClip!.recordedDurationSeconds! - seconds) < .2);
      assert.equal(saved.videoClip!.hasEmbeddedVoice, true);
      assert.ok(saved.videoClip!.fileName!.startsWith(source === "multi_feed_demo" ? "eleanor-brooks-" : "robert-hayes-"));
      const listed = await clips(new Request(`http://localhost/api/video-clips?residentId=${residentId}`));
      assert.ok((await listed.json()).clips.some((clip: { _id: string }) => clip._id === saved.videoClipId));
      const playable = await playback(new Request(`http://localhost/api/video-clips/${saved.videoClipId}/playback-url`), { params: Promise.resolve({ id: saved.videoClipId! }) });
      assert.equal(playable.status, 200);
      const download = await fetch((await playable.json()).playbackUrl);
      const combined = new Uint8Array(await download.arrayBuffer());
      assert.notDeepEqual(combined, fixture);
      const completedFile = join(directory, `completed.${extension}`); writeFileSync(completedFile, combined);
      const decoded = await inspectLocalMedia(completedFile);
      assert.equal(decoded.hasVideoTrack, true); assert.equal(decoded.hasAudioTrack, true);
      await act(async () => renderer!.update(createElement(Probe, { event: saved })));
      assert.equal(recorders.length, before + 1);
      await act(async () => renderer!.unmount()); renderer = undefined;
    }
    assert.equal(uploads, 2);
    assert.equal(recoveredCompletions, 1, "Retry recovers the saved clip after a lost success response");
  } finally {
    await act(async () => renderer?.unmount());
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
