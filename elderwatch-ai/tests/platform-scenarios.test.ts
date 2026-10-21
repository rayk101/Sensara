import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEMO_SCENARIOS } from "../src/lib/demoScenarios";
import { MOCK_RESIDENTS } from "../src/lib/mockData";
import { startSession } from "../src/lib/platform/sessions";
import { submitIncident } from "../src/lib/platform/incidents";
import { getRecentEvents, transitionIncident } from "../src/lib/db/events";
import { saveCaregiver, updateSettings } from "../src/lib/platform/settings";
import { enqueueNotifications, listNotifications } from "../src/lib/platform/notifications";
const times = [11, 20, 14, 5];
for (const [index, scenario] of DEMO_SCENARIOS.entries()) test(`shared workflow: ${scenario.videoFile}`, async () => {
  delete process.env.MONGODB_URI;
  const patient = MOCK_RESIDENTS.find(p => p.id === scenario.residentId)!;
  const session = await startSession({ residentId: patient.id, source: "multi_feed_demo", deviceId: scenario.id, consent: true });
  await updateSettings({ notificationsEnabled: true });
  await saveCaregiver({ id: `scenario-staff-${index}`, name: "Fictional assigned caregiver", active: true, urgentAlerts: true, channel: "imessage", destination: "+15551234567", patientIds: [patient.id] });
  const input = { residentId: patient.id, source: "multi_feed_demo", sessionId: session.id, scenarioId: scenario.id, videoTime: times[index], sourceEventId: randomUUID(), detectedAt: new Date().toISOString(), residentName: "Forged", room: "Wrong", severity: "urgent", eventType: "possible_fall", confidence: 0.1, reason: "Untrusted" };
  if (index === 1) {
    const before = (await getRecentEvents(100000)).length;
    await assert.rejects(submitIncident(input));
    assert.equal((await getRecentEvents(100000)).length, before); return;
  }
  const event = await submitIncident(input);
  assert.equal(event.residentId, patient.id); assert.equal(event.residentName, patient.name); assert.equal(event.room, patient.room); assert.equal(event.sessionId, session.id);
  assert.equal(event.eventType, index === 0 ? "possible_fall" : index === 2 ? "wandering" : "possible_choking");
  await enqueueNotifications(event);
  const notifications = (await listNotifications()).filter(n => n.eventId === event._id);
  if (index === 2) { assert.equal(event.severity, "watch"); assert.equal(notifications.length, 0); assert.equal(event.workflow?.video.status, "not_requested"); }
  else { assert.equal(event.severity, "urgent"); assert.equal(notifications.length, 1); assert.equal(notifications[0].staffId, `scenario-staff-${index}`); assert.equal(event.workflow?.video.status, "requested"); assert.equal(event.workflow?.voice.status, "queued"); }
  await transitionIncident(event._id!, "acknowledged", "Test caregiver");
  assert.equal(event.status, "acknowledged");
  await transitionIncident(event._id!, "resolved", "Test caregiver", "Safe fictional scenario ended");
  assert.equal(event.status, "resolved");
});
