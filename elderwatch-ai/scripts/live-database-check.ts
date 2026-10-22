import { measuredScenario } from "../tests/fixtures/poseFrames";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { writeFile, readFile } from "node:fs/promises";
import { getDb, getMongoClient } from "../src/lib/mongodb";
import { migrateSchema } from "../src/lib/db/schema";
import { seedResidents, saveResident, getResidentById } from "../src/lib/db/residents";
import { startSession } from "../src/lib/platform/sessions";
import { submitIncident } from "../src/lib/platform/incidents";
import { transitionIncident, getSafetyEvent } from "../src/lib/db/events";
import { DEMO_SCENARIOS } from "../src/lib/demoScenarios";
import { updateSettings, saveCaregiver } from "../src/lib/platform/settings";
import { processNotifications, listNotifications } from "../src/lib/platform/notifications";
if (process.env.SENSARA_LIVE_TESTS !== "1" || !process.env.MONGODB_DB?.startsWith("sensara_verification_")) throw new Error("Live tests require opt-in and an isolated verification database");
async function main() {
  await migrateSchema();
  if (process.argv.includes("--read-after-restart")) {
    const ids = JSON.parse(await readFile("/private/tmp/sensara-live-database-check.json", "utf8"));
    const patient = await getResidentById(ids.patientId); assert.equal(patient?.active, false);
    const e = await getSafetyEvent(ids.eventId); assert.equal(e?.status, "resolved"); assert.ok(e?.stateHistory?.some(a => a.reason));
    const db = await getDb(); assert.ok(await db.collection("event_ingestions").countDocuments({ incidentId: new ObjectId(e!._id) }) > 0);
    assert.ok(await db.collection("event_ingestions").countDocuments() > 0);
    console.log("PASS: patient changes, resolved incident, audit and ingestion records survive a new Node process"); return;
  }
  await seedResidents();
  await updateSettings({ notificationsEnabled: true, voiceEnabled: true, recordingEnabled: true, dataMode: "demo" });
  const id = `livecheck_${randomUUID()}`;
  await saveResident({ id, name: "Fictional Persistence Test", age: 80, room: "Test room", fallRisk: "Low", mobility: "Independent", conditions: [], careNotes: "Synthetic test only" });
  await saveResident({ room: "Updated test room" }, id); assert.equal((await getResidentById(id))?.room, "Updated test room");
  await saveResident({ active: false }, id);
  let eventId = "";
  for (const [i, scenario] of DEMO_SCENARIOS.entries()) {
    const session = await startSession({ residentId: scenario.residentId, source: "multi_feed_demo", deviceId: scenario.id, consent: true });
    await saveCaregiver({ id: `test-staff-${i}`, name: "Fictional test recipient", channel: "imessage", destination: "+15551234567", patientIds: [scenario.residentId], active: true, urgentAlerts: true });
    const input = { residentId: scenario.residentId, source: "multi_feed_demo", sessionId: session.id, scenarioId: scenario.id, videoTime: 6, poseFrames: measuredScenario(i), sourceEventId: randomUUID(), detectedAt: new Date().toISOString() };
    if (i === 1) { await assert.rejects(submitIncident(input)); continue; }
    const results = await Promise.all(Array.from({ length: 5 }, () => submitIncident(input)));
    assert.equal(new Set(results.map(r => r._id)).size, 1);
    const event = results[0];
    // Real Atlas outbox storage, mocked messaging transport: no external recipient is contacted here.
    await processNotifications(async () => "mock-transport-not-delivery");
    const notices = (await listNotifications()).filter(n => n.eventId === event._id);
    assert.equal(notices.length, i === 2 ? 0 : 1);
    const ack = await Promise.all([transitionIncident(event._id!, "acknowledged", "Caregiver A"), transitionIncident(event._id!, "acknowledged", "Caregiver B")]);
    assert.equal(ack[0]?.acknowledgedBy, ack[1]?.acknowledgedBy);
    await transitionIncident(event._id!, "resolved", "Test caregiver", "Synthetic end-to-end check complete");
    eventId = event._id!;
    console.log(`PASS: Atlas scenario ${scenario.id}, idempotency, independent workflow intents, assignment and atomic response transitions`);
  }
  await writeFile("/private/tmp/sensara-live-database-check.json", JSON.stringify({ patientId: id, eventId }), { mode: 0o600 });
  console.log("PASS: fictional patient CRUD and deactivation");
}
main().catch(e => { console.error(e instanceof Error ? e.message : "Database check failed"); process.exitCode = 1; }).finally(async () => { await (await getMongoClient()).close(); });
