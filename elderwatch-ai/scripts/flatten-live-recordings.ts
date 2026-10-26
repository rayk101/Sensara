/** Move completed live-camera videos without re-encoding or changing demo storage. */
import { BSON, ObjectId, type Document, type Filter } from "mongodb";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getDb, getMongoClient } from "../src/lib/mongodb";
import { getS3Bucket, getS3Client } from "../src/lib/s3";
import { clipObjectKey } from "../src/lib/clipPolicy";
import { readVoiceAssetAudio, type VoiceAsset } from "../src/lib/platform/voice";
import type { SafetyEvent } from "../src/lib/types";

const apply = process.argv.includes("--apply");
const dirIndex = process.argv.indexOf("--directory");
const directory = dirIndex < 0 ? "" : resolve(process.argv[dirIndex + 1]);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const db = await getDb(), s3 = getS3Client(), bucket = getS3Bucket();
  const events = await db.collection("safety_events").find({ $or: [{ source: "live_camera" }, { source: "manual", recordingSource: "live_camera", sessionId: { $type: "string" } }] }).toArray();
  const clips = await db.collection("video_clips").find({ eventId: { $in: events.map(e => String(e._id)) } }).toArray();
  const intents = await db.collection("upload_intents").find({ eventId: { $in: events.map(e => String(e._id)) } }).toArray();
  if (intents.some(i => i.status === "pending" && Date.parse(i.expiresAt) > Date.now())) throw new Error("A live recording is still uploading; retry after completion");
  const voices = await db.collection<VoiceAsset>("voice_assets").find({ s3Key: { $exists: true } }).toArray();
  const demoBefore = BSON.EJSON.stringify(await db.collection("video_clips").find({ s3Key: /^critical-events\/demo\// }).sort({ _id: 1 }).toArray());
  const plan = clips.map(clip => {
    const record = events.find(e => String(e._id) === clip.eventId)!;
    const event = { ...record, _id: String(record._id) } as unknown as SafetyEvent;
    if (clip.bucket !== bucket || !clip.hasEmbeddedVoice || !String(clip.s3Key).startsWith("critical-events/")) throw new Error(`Review incomplete clip ${clip._id} before moving`);
    return { clip, newKey: clipObjectKey(event, clip.contentType.includes("mp4") ? "mp4" : "webm") };
  });
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", clips: plan.map(p => ({ id: String(p.clip._id), oldKey: p.clip.s3Key, newKey: p.newKey })), legacyVoiceFiles: voices.length }, null, 2));
  if (!apply) return;
  if (!directory) throw new Error("--directory is required for backups");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "database-before.json"), BSON.EJSON.stringify({ clips, events, intents, voices }, { relaxed: false }), { mode: 0o600, flag: "wx" })
    .catch(error => { if (error.code !== "EEXIST") throw error; });
  const manifest: Array<Record<string, unknown>> = await readFile(join(directory, "verified-moves.json"), "utf8")
    .then(text => JSON.parse(text)).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  for (const { clip, newKey } of plan) {
    if (clip.s3Key === newKey) continue;
    const original = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: clip.s3Key }));
    if (!original.Body) throw new Error("Original clip missing");
    const bytes = await original.Body.transformToByteArray();
    if (bytes.length !== clip.fileSize) throw new Error("Original clip size does not match the saved record");
    await writeFile(join(directory, `${clip._id}-original.${clip.contentType.includes("mp4") ? "mp4" : "webm"}`), bytes, { mode: 0o600 });
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: newKey, Body: bytes, ContentType: clip.contentType,
        Metadata: original.Metadata, IfNoneMatch: "*" }));
    } catch (error) { if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error; }
    const saved = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: newKey }));
    if (!saved.Body || hash(await saved.Body.transformToByteArray()) !== hash(bytes)) throw new Error("Copied video failed verification");
    const fileName = newKey.split("/").at(-1), session = (await getMongoClient()).startSession();
    try {
      await session.withTransaction(async () => {
        const changed = await db.collection("video_clips").updateOne({ _id: clip._id, s3Key: clip.s3Key }, { $set: { s3Key: newKey, fileName } }, { session });
        if (changed.matchedCount !== 1) throw new Error("Clip changed during the move");
        const event = await db.collection("safety_events").updateOne({ _id: { $in: [clip.eventId, new ObjectId(clip.eventId)] } } as Filter<Document>,
          { $set: { "videoClip.s3Key": newKey, "videoClip.fileName": fileName } }, { session });
        if (event.matchedCount !== 1) throw new Error("Incident missing during move");
        await db.collection("upload_intents").updateMany({ eventId: clip.eventId }, { $set: { s3Key: newKey } }, { session });
      });
    } finally { await session.endSession(); }
    manifest.push({ clipId: String(clip._id), oldKey: clip.s3Key, newKey, sha256: hash(bytes), durationSeconds: clip.durationSeconds });
    await writeFile(join(directory, "verified-moves.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    console.log(`Verified flat live-camera clip: ${fileName}`);
  }
  for (const voice of voices) {
    const audio = await readVoiceAssetAudio(voice);
    await writeFile(join(directory, `voice-${voice.id}.mp3`), audio, { mode: 0o600 });
    await db.collection("voice_assets").updateOne({ id: voice.id }, { $set: { audioBase64: Buffer.from(audio).toString("base64") }, $unset: { s3Key: "" } });
  }
  const demoAfter = BSON.EJSON.stringify(await db.collection("video_clips").find({ s3Key: /^critical-events\/demo\// }).sort({ _id: 1 }).toArray());
  if (demoAfter !== demoBefore) throw new Error("Demo records changed during migration");
  const references = await Promise.all([
    db.collection("video_clips").countDocuments({ s3Key: /^critical-events\/live-camera\/residents\// }),
    db.collection("safety_events").countDocuments({ "videoClip.s3Key": /^critical-events\/live-camera\/residents\// }),
    db.collection("upload_intents").countDocuments({ s3Key: /^critical-events\/live-camera\/residents\// }),
    db.collection("voice_assets").countDocuments({ s3Key: { $exists: true } }),
  ]);
  if (references.some(Boolean)) throw new Error("Old references remain; do not remove old folders");
  console.log(JSON.stringify({ moved: manifest.length, demoUnchanged: true, oldReferences: references, cleanupPrefixes: ["critical-events/live-camera/residents/", "critical-events/voice/"] }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Move failed"); process.exitCode = 1; })
  .finally(async () => { await (await getMongoClient()).close(); getS3Client().destroy(); });
