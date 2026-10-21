import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ObjectId } from "mongodb";
import { getDb, getMongoClient } from "../src/lib/mongodb";
if (process.env.SENSARA_LIVE_TESTS !== "1" || !process.env.MONGODB_DB?.startsWith("sensara_verification_")) throw new Error("Isolated database required");
async function main() {
  const db = await getDb(), result = JSON.parse(await readFile("/private/tmp/sensara-live-provider-results.json", "utf8"));
  const replayEvent = await db.collection("safety_events").findOne({ residentId: "resident_001", status: "open", severity: "urgent" });
  assert.ok(replayEvent, "The new fall episode must exist");
  if (process.argv.includes("--prepare-cached-playback")) {
    // Reuse the already approved fictional fall audio. This fixture makes no
    // new ElevenLabs request and does not reopen the resolved incident.
    const asset = await db.collection("voice_assets").findOne({ id: result.eventId });
    assert.ok(asset, "The live-generated audio must already be stored");
    const { _id: ignored, ...reusable } = asset;
    void ignored;
    await db.collection("voice_assets").updateOne({ id: replayEvent._id.toString() }, { $set: { ...reusable, id: replayEvent._id.toString(), verificationReusedFrom: result.eventId } }, { upsert: true });
    await db.collection("safety_events").updateOne({ _id: replayEvent._id }, { $set: { "workflow.voice.status": "ready" } });
    await db.collection("application_settings").updateOne({ id: "default" }, { $set: { voiceEnabled: true, notificationsEnabled: false, recordingEnabled: false } });
    console.log("Prepared cached fictional audio playback; no provider generation or messaging requested.");
    return;
  }
  const event = await db.collection("safety_events").findOne({ _id: new ObjectId(result.eventId) });
  assert.equal(event?.status, "resolved"); assert.equal(event?.acknowledged, true); assert.equal(event?.videoClipId, result.s3.clipId);
  assert.ok(event?.stateHistory.some((h: { reason?: string; actorId?: string }) => h.reason?.includes("browser video and audio verified") && h.actorId === "demo-caregiver"));
  assert.ok(await db.collection("notifications").countDocuments({ eventId: replayEvent._id.toString(), channel: "voice", status: "played", deviceId: { $exists: true } }) > 0, "Actual browser playback completion must persist for the cached-audio retest");
  for (const id of ["resident_001", "resident_003", "demo_resident_004"]) assert.equal(await db.collection("safety_events").countDocuments({ residentId: id, status: "open" }), 1);
  assert.equal(await db.collection("safety_events").countDocuments({ residentId: "resident_002" }), 0);
  assert.equal((await db.collection("safety_events").findOne({ residentId: "resident_001", status: "open" }))?.severity, "urgent");
  console.log("PASS: fresh-process reads confirm browser resolution/audit and linked clip; the separate cached-audio browser retest persists played; one active episode per abnormal demo feed remains after refresh; stable feed creates none.");
}
main().catch(error => { console.error(error?.code === "ERR_ASSERTION" ? error.message : "Final persistence verification failed"); process.exitCode = 1; }).finally(async () => { await (await getMongoClient()).close(); });
