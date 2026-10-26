/** Dry-run by default. Copy + verify + atomically relink before any old S3 deletion. */
import { BSON, ObjectId, type Document, type Filter } from "mongodb";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getDb, getMongoClient } from "../src/lib/mongodb";
import { getS3Bucket, getS3Client } from "../src/lib/s3";
import { clipObjectKey, patientFolderName } from "../src/lib/clipPolicy";
import { renderRecordingWithVoice, inspectLocalMedia, recordingMetadata, completedRecording } from "../src/lib/platform/recordingMedia";
import { readVoiceAssetAudio, recordingSpeech, type VoiceAsset } from "../src/lib/platform/voice";
import { assignLiveDetectionNumber, previewLiveDetectionNumbers } from "../src/lib/platform/liveDetectionNumbers";
import type { SafetyEvent } from "../src/lib/types";

const apply = process.argv.includes("--apply");
const directoryIndex = process.argv.indexOf("--directory");
const directory = directoryIndex >= 0 ? resolve(process.argv[directoryIndex + 1]) : "";
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const idQuery = (id: string) => ({ $in: ObjectId.isValid(id) ? [new ObjectId(id), id] : [id] });

async function main() {
  const db = await getDb(), s3 = getS3Client(), bucket = getS3Bucket();
  if (!bucket) throw new Error("S3 bucket is required");
  const clips = await db.collection("video_clips").find({}).toArray();
  const events = await db.collection("safety_events").find({ _id: { $in: clips.flatMap(c => ObjectId.isValid(c.eventId) ? [new ObjectId(c.eventId), c.eventId] : [c.eventId]) } }).toArray();
  const voices = await db.collection<VoiceAsset>("voice_assets").find({}).toArray();
  const intents = await db.collection("upload_intents").find({}).toArray();
  if (intents.some(i => i.status === "pending" && Date.parse(i.expiresAt) > Date.now())) throw new Error("Wait for active recordings to finish before migrating");
  const preview = await previewLiveDetectionNumbers(events.map(event => ({ ...event, _id: String(event._id) }) as unknown as SafetyEvent));
  const plan = clips.map(clip => {
    const record = events.find(e => String(e._id) === String(clip.eventId));
    if (!record || clip.bucket !== bucket || !String(clip.s3Key).startsWith("critical-events/")) throw new Error(`Clip ${clip._id} needs manual review before migration`);
    const event = preview.find(event => event._id === String(record._id))!;
    const extension: "mp4" | "webm" = clip.contentType.startsWith("video/mp4") ? "mp4" : "webm";
    return { clip, event, extension, oldKey: String(clip.s3Key), newKey: clipObjectKey(event, extension) };
  }).sort((a, b) => preview.indexOf(a.event) - preview.indexOf(b.event));
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", clips: plan.map(p => ({ id: String(p.clip._id), oldKey: p.oldKey, newKey: p.newKey })), cachedVoiceAssets: voices.length }, null, 2));
  if (!apply) return;
  if (!directory) throw new Error("--directory is required for the backup and verification manifest");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A rerun must never overwrite the original database backup.
  await writeFile(join(directory, "database-before.json"), BSON.EJSON.stringify({ clips, events, voices, intents }, { relaxed: false }), { mode: 0o600, flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const manifest: Array<Record<string, unknown>> = await readFile(join(directory, "verified-migration.json"), "utf8")
    .then(text => JSON.parse(text).recordings).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const saveManifest = () => writeFile(join(directory, "verified-migration.json"), JSON.stringify({ bucket, migratedAt: new Date().toISOString(), recordings: manifest }, null, 2), { mode: 0o600 });
  await saveManifest();

  for (const item of plan) {
    const { clip, event, oldKey, newKey: plannedKey, extension } = item;
    if (oldKey === plannedKey && clip.hasEmbeddedVoice && clip.recordingFormatVersion === 2) continue;
    if (clip.hasEmbeddedVoice) throw new Error("Already narrated recordings need flatten-live-recordings.ts; do not mix their alert twice");
    const source = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: oldKey }));
    if (!source.Body || !source.ContentLength || source.ContentLength > 50 * 1024 * 1024) throw new Error("Invalid source object");
    const original = await source.Body.transformToByteArray();
    const sourceFile = join(directory, `${clip._id}-original.${extension}`);
    await writeFile(sourceFile, original, { mode: 0o600, flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const originalMedia = await inspectLocalMedia(sourceFile);
    const voice = voices.find(v => v.id === String(event._id));
    const audio = voice ? await readVoiceAssetAudio(voice) : await recordingSpeech(event);
    await writeFile(join(directory, `${clip._id}-alert.mp3`), audio, { mode: 0o600 });
    const rendered = await renderRecordingWithVoice(original, audio, extension, clip.recordedDurationSeconds ?? originalMedia.durationSeconds);
    const { bytes, ...newFinished } = rendered;
    const numbered = await assignLiveDetectionNumber(event);
    const newKey = clipObjectKey(numbered, extension);
    let finished = newFinished;
    let token: string = randomUUID();
    const sourceHash = sha(original), voiceHash = sha(audio);
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: newKey, Body: bytes, ContentType: finished.contentType,
        IfNoneMatch: "*", Metadata: { ...recordingMetadata(finished, token), "source-sha256": sourceHash, "voice-sha256": voiceHash } }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
    }
    const uploaded = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: newKey }));
    if (!uploaded.Body) throw new Error("Migration target is missing");
    const downloaded = await uploaded.Body.transformToByteArray();
    if (sha(downloaded) !== sha(bytes)) {
      // FFmpeg may choose a new container ID each time. A verified earlier attempt
      // can be reused only if both its input hashes match this exact migration.
      const prior = completedRecording(uploaded.Metadata, { s3Key: newKey, bucket, fileSize: downloaded.length, contentType: finished.contentType, processingToken: uploaded.Metadata?.["sensara-token"] });
      if (!prior || uploaded.Metadata?.["source-sha256"] !== sourceHash || uploaded.Metadata?.["voice-sha256"] !== voiceHash || prior.fileSize !== downloaded.length) throw new Error(`Existing target differs; original is unchanged: ${newKey}`);
      finished = prior; token = uploaded.Metadata["sensara-token"];
    }
    const outputFile = join(directory, `${clip._id}-with-voice.${extension}`);
    await writeFile(outputFile, downloaded, { mode: 0o600 });
    const verification = await inspectLocalMedia(outputFile);
    if (!verification.hasAudioTrack || !verification.hasVideoTrack) throw new Error("Migrated clip is incomplete");
    const fileName = newKey.split("/").at(-1);
    const meta = { s3Key: newKey, fileName, bucket, contentType: finished.contentType, durationSeconds: finished.durationSeconds,
      recordedDurationSeconds: finished.recordedDurationSeconds, hasEmbeddedVoice: true, clipStartTime: clip.clipStartTime, clipEndTime: clip.clipEndTime };
    const session = (await getMongoClient()).startSession();
    try {
      await session.withTransaction(async () => {
        const updated = await db.collection("video_clips").updateOne({ _id: clip._id, s3Key: oldKey }, { $set: { ...finished, s3Key: newKey, fileName, hasVideoTrack: true } }, { session });
        if (updated.matchedCount !== 1) throw new Error("Clip changed during migration");
        const linked = await db.collection("safety_events").updateOne({ _id: idQuery(String(event._id)) } as Filter<Document>, { $set: { videoClip: meta, videoClipId: String(clip._id), hasVideoClip: true,
          "workflow.video": { status: "available", updatedAt: new Date().toISOString() } } }, { session });
        if (linked.matchedCount !== 1) throw new Error("Incident disappeared during migration");
        await db.collection("upload_intents").updateMany({ eventId: String(event._id) }, { $set: { s3Key: newKey, clipId: String(clip._id), status: "uploaded", processingToken: token } }, { session });
      });
    } finally { await session.endSession(); }
    manifest.push({ clipId: String(clip._id), oldKey, newKey, sha256: sha(downloaded), bytes: downloaded.length, ...verification, backup: sourceFile });
    await saveManifest();
    console.log(`Verified and linked ${newKey}`);
  }
  // Keep alert playback working even for incidents that never had a captured video.
  for (const voice of voices) {
    const audio = await readVoiceAssetAudio(voice);
    await writeFile(join(directory, `voice-${voice.id}.mp3`), audio, { mode: 0o600 });
    await db.collection("voice_assets").updateOne({ id: voice.id }, { $set: { audioBase64: Buffer.from(audio).toString("base64") }, $unset: { s3Key: "" } });
  }
  const patients = await db.collection("residents").find({}, { projection: { id: 1, name: 1 } }).toArray();
  for (const source of ["demo"]) for (const patient of patients) {
    if (!/^[a-zA-Z0-9_-]+$/.test(patient.id)) throw new Error("Invalid patient ID");
    const key = `critical-events/${source}/residents/${patientFolderName(patient.name)}--${patient.id}/`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.alloc(0), ContentLength: 0, ContentType: "application/x-directory" }));
  }
  const oldReferences = await Promise.all([
    db.collection("video_clips").countDocuments({ s3Key: /^critical-events\/(incidents|resident_001|voice)\// }),
    db.collection("safety_events").countDocuments({ "videoClip.s3Key": /^critical-events\/(incidents|resident_001|voice)\// }),
    db.collection("upload_intents").countDocuments({ s3Key: /^critical-events\/(incidents|resident_001|voice)\// }),
    db.collection("voice_assets").countDocuments({ s3Key: { $exists: true } }),
  ]);
  if (oldReferences.some(Boolean)) throw new Error("Some old references remain; do not delete old S3 folders");
  // Re-read the on-disk manifest to prove the evidence was saved before cleanup.
  console.log(`Migration verified. Old references: ${oldReferences.join(",")}. Manifest: ${join(directory, "verified-migration.json")}`);
  await readFile(join(directory, "verified-migration.json"));
}
main().catch(error => { console.error(error instanceof Error ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, "[redacted]") : "Migration failed"); process.exitCode = 1; })
  .finally(async () => { await (await getMongoClient()).close(); getS3Client().destroy(); });
