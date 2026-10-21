import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useDemoPlayback } from "../src/hooks/useDemoPlayback";

test("demo playback waits for a session and recovers from a blocked play without replacing the video", async () => {
  let plays = 0, pauses = 0;
  const video = { play: () => { plays++; return Promise.reject(new Error("NotAllowedError")); }, pause: () => { pauses++; } } as unknown as HTMLVideoElement;
  const ref = { current: video };
  let playback!: ReturnType<typeof useDemoPlayback>, renderer: ReactTestRenderer | undefined;
  function Probe({ sessionId }: { sessionId: string | null }) { playback = useDemoPlayback(ref, false, sessionId); return null; }
  try {
    await act(async () => { renderer = create(createElement(Probe, { sessionId: null })); });
    assert.equal(plays, 0); assert.equal(pauses, 1);
    await act(async () => renderer!.update(createElement(Probe, { sessionId: "session" })));
    assert.equal(playback.status, "blocked");
    video.play = () => { plays++; return Promise.resolve(); };
    await act(async () => playback.retry());
    await act(async () => playback.setStatus("playing")); // actual playing event
    assert.equal(playback.status, "playing"); assert.equal(plays, 2); assert.equal(ref.current, video);
  } finally { await act(async () => renderer?.unmount()); }
});

test("a stale rejected play after pause/resume cannot block the new attempt", async () => {
  const rejections: Array<(error: Error) => void> = [];
  const ref = { current: { play: () => new Promise<void>((_, reject) => rejections.push(reject)), pause: () => {} } as HTMLVideoElement };
  let playback!: ReturnType<typeof useDemoPlayback>, renderer: ReactTestRenderer | undefined;
  function Probe({ paused }: { paused: boolean }) { playback = useDemoPlayback(ref, paused, "session"); return null; }
  try {
    await act(async () => { renderer = create(createElement(Probe, { paused: false })); });
    await act(async () => renderer!.update(createElement(Probe, { paused: true })));
    await act(async () => renderer!.update(createElement(Probe, { paused: false })));
    await act(async () => playback.setStatus("playing"));
    await act(async () => rejections[0](new Error("AbortError")));
    assert.equal(playback.status, "playing"); assert.equal(rejections.length, 2);
  } finally { await act(async () => renderer?.unmount()); }
});
