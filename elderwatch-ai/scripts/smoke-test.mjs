import assert from "node:assert/strict";

const base = process.env.BASE_URL || "http://127.0.0.1:3000";
async function request(path, method = "GET", body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
const status = await request("/api/status");
assert.equal(status.demoMode, true, "Smoke tests require local demo mode (no MONGODB_URI)");
assert.equal(status.smsConfigured, false, "Disable SMS for smoke tests");
assert.equal(status.emailConfigured, false, "Disable email for smoke tests");
const { residents } = await request("/api/residents");
assert.ok(residents.length >= 3);
const resident = residents[0];
const before = await request("/api/analytics");
const sample = {
  source: "multi_feed_demo", residentId: resident.id, residentName: resident.name,
  room: resident.room, severity: "watch", eventType: "wandering", confidence: 0.8,
  reason: "Local smoke test — simulated alert",
};
const event = await request("/api/events", "POST", sample, 201);
assert.ok(event._id);
assert.equal(event.source, "multi_feed_demo");
assert.equal(typeof event.signals.postureAngle, "number");
const recent = await request(`/api/events?residentId=${resident.id}&limit=50`);
assert.ok(recent.events.some(item => item._id === event._id));
const after = await request("/api/analytics");
assert.equal(after.totalEventsLast24h, before.totalEventsLast24h + 1);
const acknowledged = await request(`/api/events/${event._id}/acknowledge`, "PATCH", { acknowledgedBy: "Smoke Test" });
assert.equal(acknowledged.acknowledged, true);
await request(`/api/events/${event._id}/notes`, "POST", { residentId: resident.id, note: "Verified locally", createdBy: "Smoke Test" }, 201);
const { notes } = await request(`/api/events/${event._id}/notes`);
assert.equal(notes[0].note, "Verified locally");
const history = await request(`/api/residents/${resident.id}/history`);
assert.ok(history.recentEvents.some(item => item._id === event._id && item.acknowledged));
await request("/api/events?limit=-1", "GET", undefined, 400);
await request("/api/events?limit=oops", "GET", undefined, 400);
await request("/api/events", "POST", { ...sample, severity: "invalid" }, 400);
await request("/api/events", "POST", { ...sample, confidence: 4 }, 400);
await request(`/api/events/${event._id}/notes`, "POST", { note: 12 }, 400);
await request("/api/events/missing/notes", "POST", { note: "orphan" }, 404);
await request("/api/events/missing/acknowledge", "PATCH", {}, 404);
const audio = await request("/api/audio/analyze", "POST", { simulate: true, residentId: resident.id, residentName: resident.name, room: resident.room });
assert.equal(audio.event._id, audio.eventId);
assert.equal(audio.event.source, "audio_monitor");
assert.equal(audio.classification.severity, "urgent");
const guidance = await request("/api/assistant", "POST", { question: "What should I document?", resident, classification: audio.classification });
assert.equal(guidance.generatedBy, "mock");
assert.ok(guidance.guidance.length > 20);
await request("/api/video-clips/presign-upload", "POST", {}, 503);
await request("/api/video-clips/missing/playback-url", "GET", undefined, 404);
await request("/api/video-clips/clip_001/playback-url", "GET", undefined, 503);
for (const file of ["fall-demo.mp4", "stable-demo.mp4", "wandering-demo.mp4", "choking-demo.mp4"]) {
  const response = await fetch(`${base}/demo-videos/${file}`, { method: "HEAD" });
  assert.equal(response.status, 200, file);
  assert.ok(Number(response.headers.get("content-length")) > 0, file);
}
console.log("PASS: event persistence, analytics refresh, acknowledgement, notes, resident history, validation, audio simulation, assistant fallback, disabled storage, and all demo video assets.");
console.log("Test records remain in the local in-memory demo until the server restarts.");
