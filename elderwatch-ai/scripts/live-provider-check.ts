import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { getDb, getMongoClient } from "../src/lib/mongodb";
import { submitIncident } from "../src/lib/platform/incidents";
import { updateSettings, saveCaregiver } from "../src/lib/platform/settings";
import { prepareUpload, completeUpload } from "../src/lib/platform/uploads";
import { incidentSpeech, processVoiceWork } from "../src/lib/platform/voice";
import { processNotifications, listNotifications } from "../src/lib/platform/notifications";
import { createPresignedDownloadUrl } from "../src/lib/s3";
if (process.env.SENSARA_LIVE_TESTS !== "1" || !process.env.MONGODB_DB?.startsWith("sensara_verification_")) throw new Error("Explicit opt-in and isolated database required");
async function main() {
  const db = await getDb();
  await db.collection("staff").updateMany({}, { $set: { active: false } });
  await updateSettings({ notificationsEnabled: true, recordingEnabled: true, voiceEnabled: true, dataMode: "demo" });
  await saveCaregiver({ id: "approved-demo-recipient", name: "Approved test caregiver", active: true, urgentAlerts: true, patientIds: ["resident_001"], channel: "imessage", destination: process.env.CAREGIVER_PHONE_NUMBER! });
  const event = await submitIncident({ residentId: "resident_001", source: "manual", sourceEventId: randomUUID(), detectedAt: new Date().toISOString(), severity: "urgent", eventType: "possible_fall", confidence: 0.9, reason: "Fictional integration test: synthetic fall signal" });
  assert.equal(event.residentName, "Eleanor Brooks"); assert.equal(event.room, "Room 204");
  const results: Record<string, unknown> = { eventId: event._id, patientId: event.residentId, room: event.room, database: process.env.MONGODB_DB };
  // All three branches begin together; video completion cannot gate remote alerts.
  await Promise.all([
    (async () => {
      try {
        const audio = await incidentSpeech(event._id!);
        await writeFile("/private/tmp/sensara-live-voice.mp3", audio, { mode: 0o600 });
        await processVoiceWork();
        results.voice = { generation: "passed", bytes: audio.length, playback: "not yet tested" };
        console.log("PASS: live ElevenLabs generated speech and private voice asset persisted");
      } catch { results.voice = "FAILED: generation rejected or storage failed"; console.log(results.voice); }
    })(),
    (async () => {
      await processNotifications();
      const notification = (await listNotifications()).find(n => n.eventId === event._id && n.channel === "imessage");
      results.photon = notification ? { status: notification.status, error: notification.error, providerMessageId: notification.providerMessageId, transport: "imessage" } : "No notification record";
      console.log(`Photon live outcome: ${notification?.status ?? "missing"}${notification?.error ? ` — ${notification.error}` : ""}`);
    })(),
    (async () => {
      try {
        const video = await readFile("/private/tmp/sensara-synthetic-15s.mp4");
        const start = new Date().toISOString();
        await new Promise(resolve => setTimeout(resolve, 15000));
        const end = new Date().toISOString();
        const intent = await prepareUpload({ eventId: event._id, residentId: event.residentId, contentType: "video/mp4", fileSize: video.length });
        const upload = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: video }); assert.equal(upload.status, 200);
        const duplicate = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: video }); assert.equal(duplicate.status, 412);
        const clip = await completeUpload({ uploadId: intent.uploadId, eventId: event._id, residentId: event.residentId, clipStartTime: start, clipEndTime: end, hasAudioTrack: false });
        assert.equal(clip.event?.videoClipId?.toString(), clip._id?.toString());
        const playback = await fetch(await createPresignedDownloadUrl(intent.s3Key)); assert.equal(playback.status, 200); assert.deepEqual(Buffer.from(await playback.arrayBuffer()), video);
        const anonymous = await fetch(`https://${intent.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${intent.s3Key}`); assert.equal(anonymous.status, 403);
        results.s3 = { upload: "passed", privateRead: "passed", anonymousRead: "denied", overwrite: "denied", clipId: clip._id, bytes: video.length, browserPlayback: "not yet tested" };
        console.log("PASS: live S3 upload, verified incident linkage, byte-for-byte read, denied public access and overwrite");
      } catch { results.s3 = "FAILED: upload or verification failed"; console.log(results.s3); }
    })(),
  ]);
  await writeFile("/private/tmp/sensara-live-provider-results.json", JSON.stringify(results, null, 2), { mode: 0o600 });
}
main().catch(() => { console.error("Live provider test failed before branches completed"); process.exitCode = 1; }).finally(async () => { await (await getMongoClient()).close(); });
