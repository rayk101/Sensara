import { test } from "node:test";
import assert from "node:assert/strict";
import { getInMemoryStore, generateMockEvents, InMemoryStore } from "../src/lib/mockData";
import { createSafetyEvent, acknowledgeEvent, getEventsByResident, linkVideoClipToEvent } from "../src/lib/db/events";
import { createCaregiverNote, getNotesForEvent } from "../src/lib/db/notes";

test("a saved event keeps its identity across acknowledgement, notes, and clip linking", async () => {
  delete process.env.MONGODB_URI;
  const { _id, ...sample } = generateMockEvents()[0];
  const event = await createSafetyEvent({ ...sample, residentId: "regression-test", createdAt: new Date().toISOString(), acknowledged: false });
  assert.ok(event._id && event._id !== _id);
  assert.equal((await getEventsByResident("regression-test"))[0]._id, event._id);
  assert.equal((await acknowledgeEvent(event._id!, "Test Caregiver"))?.acknowledged, true);
  await createCaregiverNote({ residentId: event.residentId, eventId: event._id!, note: "Checked resident", createdBy: "Test", createdAt: event.createdAt });
  assert.equal((await getNotesForEvent(event._id!))[0].note, "Checked resident");
  const linked = await linkVideoClipToEvent(event._id!, "test-clip", {
    s3Key: "test.webm", bucket: "demo", contentType: "video/webm", durationSeconds: 15,
    clipStartTime: event.createdAt, clipEndTime: event.createdAt,
  });
  assert.equal(linked?.videoClipId, "test-clip");
  assert.equal(linked?.hasVideoClip, true);
  assert.equal(await linkVideoClipToEvent("missing", "clip", linked!.videoClip!), null);
  assert.strictEqual(getInMemoryStore(), getInMemoryStore());
});

test("resident totals include events beyond the recent-history display limit", () => {
  const store = new InMemoryStore();
  const sample = generateMockEvents()[0];
  for (let i = 0; i < 40; i++) store.createEvent({ ...sample, _id: `history-${i}`, residentId: "history-test", createdAt: new Date().toISOString() });
  const history = store.getResidentHistory("history-test");
  assert.equal(history.totalEventsToday, 40);
  assert.equal(history.urgentEvents, 40);
  assert.equal(history.recentEvents.length, 20);
});
