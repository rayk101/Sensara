import { test } from "node:test";
import assert from "node:assert/strict";
import { messageProgress, updateActivityFeed, type ActivityFeed, type MonitoringActivity } from "../src/lib/monitoringActivity";
import { generateMockEvents } from "../src/lib/mockData";

test("watching and critical snapshots stay distinct when one saved incident is promoted", () => {
  const event = generateMockEvents()[0];
  const watching: MonitoringActivity = { id: "watch", source: "camera", residentId: event.residentId, residentName: event.residentName,
    room: event.room, observedAt: event.createdAt, severity: "watch", eventType: "unsafe_posture", reason: "Hand near neck", confidence: .8, persistence: "pending" };
  let feed: ActivityFeed = { entries: [], current: {} };
  feed = updateActivityFeed(feed, { type: "observed", activity: watching });
  feed = updateActivityFeed(feed, { type: "saved", id: watching.id, event: { ...event, severity: "watch" } });
  feed = updateActivityFeed(feed, { type: "observed", activity: { ...watching, id: "critical", severity: "urgent", reason: "Sustained neck gesture" } });
  feed = updateActivityFeed(feed, { type: "saved", id: "critical", event });
  assert.deepEqual(feed.entries.map(entry => entry.severity), ["urgent", "watch"]);
  assert.deepEqual(feed.entries.map(entry => entry.event?._id), [event._id, event._id]);
  feed = updateActivityFeed(feed, { type: "inactive", source: "camera" });
  assert.equal(feed.current.camera, null);
  assert.equal(feed.entries.length, 2, "Pausing changes the active status without removing the notification log");
  feed = updateActivityFeed(feed, { type: "failed", id: "critical" });
  assert.equal(feed.entries[0].persistence, "failed");
  assert.equal(feed.entries[0].severity, "urgent", "Persistence failure cannot suppress a locally detected critical update");
});

test("notification text never equates queueing or provider acceptance with delivery or dispatched help", () => {
  for (const status of ["queued", "submitted", "accepted", "failed", "unknown", "cancelled"]) {
    const messages = messageProgress(undefined, [{ channel: "sms", status }], "saved").join(" ");
    assert.doesNotMatch(messages, /SMS: delivered|help is on the way/i);
  }
  assert.deepEqual(messageProgress(undefined, [{ channel: "sms", status: "delivered" }], "saved"), ["SMS: delivered."]);
  assert.match(messageProgress(undefined, [{ channel: "imessage", status: "accepted" }], "saved")[0], /^iMessage:.*unconfirmed/);
  assert.match(messageProgress(undefined, [], "failed")[0], /could not be saved.*unconfirmed/);
  assert.match(messageProgress(undefined, [], "pending")[0], /Awaiting incident confirmation/);
});
