import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb, getMongoClient } from "../src/lib/mongodb";
import { processNotifications } from "../src/lib/platform/notifications";
import { verifyUploadedMedia } from "../src/lib/platform/media";
import { getVideoClipById } from "../src/lib/db/videoClips";
if (process.env.SENSARA_LIVE_TESTS !== "1" || !process.env.MONGODB_DB?.startsWith("sensara_verification_")) throw new Error("Opt-in and isolated database required");
async function main() {
  const db = await getDb();
  const ids = JSON.parse(await readFile("/private/tmp/sensara-live-provider-results.json", "utf8"));
  const clip = await getVideoClipById(ids.s3.clipId); assert.ok(clip);
  const duration = await verifyUploadedMedia(clip.s3Key);
  assert.ok(duration >= 14 && duration <= 16);
  await db.collection("video_clips").updateOne({ _id: new ObjectId(ids.s3.clipId) }, { $set: { durationSeconds: duration, playableVerifiedAt: new Date().toISOString() } });
  console.log(`PASS: S3 video fully decoded; actual video duration ${duration.toFixed(2)} seconds`);
  const transaction = (await getMongoClient()).startSession(); const marker = randomUUID();
  try { await assert.rejects(transaction.withTransaction(async () => { await db.collection("event_ingestions").insertOne({ id: marker }, { session: transaction }); throw new Error("intentional rollback"); })); }
  finally { await transaction.endSession(); }
  assert.equal(await db.collection("event_ingestions").countDocuments({ id: marker }), 0);
  console.log("PASS: actual Mongo transaction rollback leaves no orphan ingestion");
  const record = { id: randomUUID(), eventId: ids.eventId, residentId: ids.patientId, staffId: "approved-demo-recipient", channel: "imessage", provider: "mock", status: "submitted", createdAt: new Date().toISOString(), nextAttemptAt: new Date(0).toISOString(), lastAttemptAt: new Date(0).toISOString(), leaseUntil: new Date(0).toISOString(), leaseOwner: "expired", retryCount: 1 };
  await db.collection("notifications").insertOne(record);
  let calls = 0;
  await processNotifications(async () => { calls++; return "mock-only"; });
  assert.equal((await db.collection("notifications").findOne({ id: record.id }))?.status, "unknown");
  assert.equal(calls, 0);
  await db.collection("notifications").insertOne({ ...record, _id: new ObjectId(), id: marker, status: "queued" });
  await Promise.all([processNotifications(async () => { calls++; return "mock-only"; }), processNotifications(async () => { calls++; return "mock-only"; })]);
  assert.equal(calls, 1);
  const accepted = await db.collection("notifications").findOne({ id: marker }); assert.equal(accepted?.status, "accepted");
  const stale = await db.collection("notifications").updateOne({ id: marker, status: "submitted", leaseOwner: "expired" }, { $set: { status: "failed" } }); assert.equal(stale.modifiedCount, 0);
  await processNotifications(async () => { calls++; return "should-not-run"; }); assert.equal(calls, 1);
  console.log("PASS: expired submission stays uncertain, concurrent workers claim once, stale owners cannot overwrite, accepted work is not rerun (mock transport)");
}
main().catch(() => { console.error("Recovery/media verification failed"); process.exitCode = 1; }).finally(async () => { await (await getMongoClient()).close(); });
