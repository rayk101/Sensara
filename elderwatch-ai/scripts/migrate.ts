import { migrateSchema } from "../src/lib/db/schema";
import { seedResidents } from "../src/lib/db/residents";
import { getDb, getMongoClient } from "../src/lib/mongodb";
import { defaultSettings } from "../src/lib/platform/settings";
import { MOCK_RESIDENTS } from "../src/lib/mockData";
async function main() {
  await migrateSchema();
  if (process.argv.includes("--demo")) {
    await seedResidents();
    const db = await getDb();
    await db.collection("application_settings").updateOne({ id: "default" }, { $setOnInsert: { ...defaultSettings, dataMode: "demo", updatedAt: new Date().toISOString() } }, { upsert: true });
    for (const patient of MOCK_RESIDENTS) await db.collection("residents").updateOne({ id: patient.id, active: { $exists: false } }, { $set: { active: true, assignedStaffIds: ["demo-caregiver"], supportedUseCases: ["live_camera", "multi_feed_demo"], monitoringConfig: { recordingEnabled: true, audioEnabled: false } } });
    if (process.env.CAREGIVER_PHONE_NUMBER) await db.collection("staff").updateOne({ id: "demo-caregiver" }, { $setOnInsert: { id: "demo-caregiver", name: "Demo Caregiver", active: true, urgentAlerts: true, channel: "imessage", destination: process.env.CAREGIVER_PHONE_NUMBER, patientIds: MOCK_RESIDENTS.map(p => p.id) } }, { upsert: true });
  }
  console.log("Schema and indexes are ready. Existing patient and incident history retained. External notifications remain controlled by application_settings.");
}
main().catch(() => { console.error("Migration failed. Check database permissions and existing index constraints; no automatic destructive migration is performed."); process.exitCode = 1; }).finally(async () => { await (await getMongoClient()).close(); });
