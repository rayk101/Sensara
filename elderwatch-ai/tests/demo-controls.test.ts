import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useDemoControls } from "../src/hooks/useDemoControls";

const feeds = ["feed-1", "feed-2", "feed-3", "feed-4"];

test("individual play/pause is independent, and global controls include individually paused feeds", async () => {
  let controls!: ReturnType<typeof useDemoControls>;
  let renderer: ReactTestRenderer | undefined;
  function Probe() { controls = useDemoControls(feeds, true); return null; }
  try {
    await act(async () => { renderer = create(createElement(Probe)); });
    assert.deepEqual(controls.runningFeedIds, []);
    await act(async () => controls.toggleFeed("feed-2"));
    assert.deepEqual(controls.runningFeedIds, ["feed-2"]);
    await act(async () => controls.toggleFeed("feed-4"));
    await act(async () => controls.toggleFeed("feed-2"));
    assert.deepEqual(controls.runningFeedIds, ["feed-4"]);
    await act(async () => controls.startAll());
    assert.deepEqual(controls.runningFeedIds, feeds);
    assert.equal(controls.allRunning, true);
    await act(async () => controls.toggleFeed("feed-1"));
    assert.equal(controls.allRunning, false);
    assert.deepEqual(controls.runningFeedIds, feeds.slice(1));
    await act(async () => controls.startAll());
    assert.deepEqual(controls.runningFeedIds, feeds);
    await act(async () => controls.pauseAll());
    assert.deepEqual(controls.runningFeedIds, []);
    assert.equal(controls.anyRunning, false);
  } finally { await act(async () => renderer?.unmount()); }
});

test("hidden feeds stop and do not auto-resume; unavailable patients cannot be started", async () => {
  let controls!: ReturnType<typeof useDemoControls>;
  let renderer: ReactTestRenderer | undefined;
  function Probe({ enabled, ids }: { enabled: boolean; ids: string[] }) { controls = useDemoControls(ids, enabled); return null; }
  try {
    await act(async () => { renderer = create(createElement(Probe, { enabled: true, ids: feeds })); });
    await act(async () => controls.startAll());
    await act(async () => renderer!.update(createElement(Probe, { enabled: false, ids: feeds })));
    assert.deepEqual(controls.runningFeedIds, []);
    await act(async () => controls.startAll());
    await act(async () => controls.toggleFeed("feed-1"));
    await act(async () => renderer!.update(createElement(Probe, { enabled: true, ids: feeds })));
    assert.deepEqual(controls.runningFeedIds, []);
    await act(async () => controls.startAll());
    const remaining = feeds.slice(1);
    await act(async () => renderer!.update(createElement(Probe, { enabled: true, ids: remaining })));
    assert.deepEqual(controls.runningFeedIds, remaining);
    await act(async () => controls.toggleFeed("feed-1"));
    assert.deepEqual(controls.runningFeedIds, remaining);
    await act(async () => renderer!.update(createElement(Probe, { enabled: true, ids: feeds })));
    assert.deepEqual(controls.runningFeedIds, remaining);
  } finally { await act(async () => renderer?.unmount()); }
});
