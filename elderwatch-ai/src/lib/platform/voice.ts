import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client, getS3Bucket, isS3Configured } from "../s3";
import { ObjectId } from "mongodb";
import { identifier } from "./validation";
import { getDb, isMongoEnabled } from "../mongodb";
import { getSafetyEvent } from "../db/events";
import { ApiError, currentActor } from "./auth";
import { getSettings } from "./settings";
import { readRecord, writeRecord } from "./store";
import type { SafetyEvent } from "../types";
export function voiceText(event: SafetyEvent, details: boolean) {
  return details ? `Urgent alert. ${event.residentName}, ${event.room}. ${event.eventType.replace(/_/g, " ")} detected. Immediate caregiver assistance is required.` : "Urgent patient safety incident detected. Please check the secure Sensara dashboard immediately.";
}
export function isVoiceConfigured() { return !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID); }
export async function generateSpeech(text: string): Promise<Uint8Array> {
  if (!isVoiceConfigured()) throw new ApiError(503, "ElevenLabs voice alerts need a TTS-enabled key and voice ID");
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID!)}?output_format=mp3_44100_128`, {
      method: "POST", signal: AbortSignal.timeout(15_000), headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2" }),
    });
    if (response.status === 429 && attempt === 0) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
    if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, `ElevenLabs voice request rejected (HTTP ${response.status}). Check TTS permissions and voice ID.`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (!data.length || data.length > 5 * 1024 * 1024) throw new ApiError(502, "Invalid speech response");
    return data;
  }
  throw new ApiError(429, "ElevenLabs voice rate limit");
}
interface VoiceAsset { id: string; s3Key: string; contentType: string; expiresAt: string; privacy?: string }
const cache = new Map<string, Promise<Uint8Array>>();
async function speechAsset(event: SafetyEvent) {
  const settings = await getSettings();
  const id = String(event._id);
  const asset = await readRecord<VoiceAsset>("voice_assets", id);
  if (asset && Date.parse(asset.expiresAt) <= Date.now()) throw new ApiError(410, "Voice asset retention expired");
  if (asset && asset.privacy === settings.dataMode && isS3Configured()) {
    const object = await getS3Client().send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: asset.s3Key }));
    return (await object.Body!.transformToByteArray());
  }
  const cacheKey = `${id}:${settings.dataMode}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;
  const work = (async () => {
    const audio = await generateSpeech(voiceText(event, settings.dataMode === "demo"));
    if (isS3Configured()) {
      try {
      const hash = createHash("sha256").update(`${process.env.ELEVENLABS_VOICE_ID}:${process.env.ELEVENLABS_MODEL_ID}:${settings.dataMode}`).digest("hex").slice(0, 16);
      const s3Key = `critical-events/voice/${id}/${hash}.mp3`;
      await getS3Client().send(new PutObjectCommand({ Bucket: getS3Bucket(), Key: s3Key, Body: audio, ContentType: "audio/mpeg" }));
      await writeRecord("voice_assets", { id, s3Key, privacy: settings.dataMode, contentType: "audio/mpeg", expiresAt: new Date(Date.now() + settings.retentionDays * 86400_000).toISOString() });
      } catch { console.warn("Voice generated; durable audio storage unavailable"); }
    }
    return audio;
  })();
  if (cache.size >= 20) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, work);
  try { return await work; } catch (e) { cache.delete(cacheKey); throw e; }
}
export async function processVoiceWork(targetId?: string) {
  if (!isMongoEnabled()) return; // local tests invoke the same generator with mocked transports
  const db = await getDb(), owner = randomUUID(), now = new Date().toISOString();
  await db.collection("safety_events").updateMany({ "workflow.voice.status": "generating", "workflow.voice.leaseUntil": { $lt: now } }, { $set: { "workflow.voice.status": "queued" } });
  const event = await db.collection("safety_events").findOneAndUpdate({ ...(targetId ? { _id: new ObjectId(targetId) } : {}), "workflow.voice.status": "queued", $or: [{ "workflow.voice.nextAttemptAt": { $exists: false } }, { "workflow.voice.nextAttemptAt": { $lte: now } }], status: { $nin: ["resolved", "dismissed"] }, acknowledged: false }, { $set: { "workflow.voice.status": "generating", "workflow.voice.leaseOwner": owner, "workflow.voice.leaseUntil": new Date(Date.now() + 60_000).toISOString(), "workflow.voice.lastAttemptAt": now }, $inc: { "workflow.voice.attemptCount": 1 } }, { returnDocument: "after" });
  if (!event) return;
  let state;
  try { await speechAsset(event as unknown as SafetyEvent); state = { status: (await readRecord("voice_assets", event._id.toString())) ? "ready" : "ready_volatile", updatedAt: new Date().toISOString() }; }
  catch (e) {
    const retryable = !(e instanceof ApiError) || e.status === 429;
    const attempts = event.workflow?.voice?.attemptCount ?? 1;
    state = { status: retryable && attempts < 4 ? "queued" : "failed", nextAttemptAt: new Date(Date.now() + Math.min(300000, 5000 * 2 ** attempts) + Math.random() * 1000).toISOString(), updatedAt: new Date().toISOString(), error: e instanceof ApiError ? e.message : "Speech generation or storage failed" };
  }
  state = { ...state, attemptCount: event.workflow?.voice?.attemptCount ?? 1, lastAttemptAt: now, attemptId: owner };
  await db.collection("safety_events").updateOne({ _id: event._id, "workflow.voice.leaseOwner": owner }, { $set: { "workflow.voice": state } });
}
export async function incidentSpeech(id: string, deviceId = "default") {
  const event = await getSafetyEvent(id);
  if (!event || event.severity !== "urgent" || event.acknowledged || ["resolved", "dismissed"].includes(event.status ?? "")) throw new ApiError(404, "Active urgent incident not found");
  if (!(await getSettings()).voiceEnabled) throw new ApiError(409, "Voice alerts disabled");
  const recordId = `voice:${id}:${currentActor().id}:${identifier(deviceId, "playback device")}`;
  const existing = await readRecord("notifications", recordId);
  const record = { id: recordId, deviceId, generationStatus: "generating", eventId: id, residentId: event.residentId, staffId: currentActor().id, channel: "voice", provider: "elevenlabs", status: "generating", createdAt: existing?.createdAt ?? new Date().toISOString(), lastAttemptAt: new Date().toISOString(), retryCount: (existing?.retryCount ?? 0) + 1, error: null };
  try {
    if (isMongoEnabled() && !await readRecord("voice_assets", id)) {
      await (await getDb()).collection("safety_events").updateOne({ _id: new ObjectId(id), "workflow.voice.status": "failed" }, { $set: { "workflow.voice.status": "queued", "workflow.voice.nextAttemptAt": new Date().toISOString() } });
      await processVoiceWork(id);
      const latest = await getSafetyEvent(id);
      if (["queued", "generating"].includes(latest?.workflow?.voice.status ?? "")) throw new ApiError(425, "Voice generation is pending; retry shortly");
      if (latest?.workflow?.voice.status === "failed") throw new ApiError(502, latest.workflow.voice.error ?? "Speech generation failed");
    }
    const audio = await speechAsset(event);
    await writeRecord("notifications", { ...record, status: "generated", generationStatus: "ready" });
    return audio;
  } catch (error) {
    await writeRecord("notifications", { ...record, status: "failed", generationStatus: "failed", error: "Speech generation failed" });
    throw error;
  }
}
export async function recordVoicePlayback(id: string, status: string, deviceId = "default") {
  const event = await getSafetyEvent(id);
  if (!event) throw new ApiError(404, "Incident not found");
  if (!["playing", "played", "blocked", "interrupted", "playback_failed"].includes(status)) throw new ApiError(400, "Invalid playback status");
  const recordId = `voice:${id}:${currentActor().id}:${identifier(deviceId, "playback device")}`;
  const record = await readRecord("notifications", recordId);
  if (!record) throw new ApiError(409, "Generate speech before reporting playback");
  if (record.status === "played" && status !== "played") return;
  const update = { playbackStatus: status, status, lastAttemptAt: new Date().toISOString() };
  if (isMongoEnabled()) await (await getDb()).collection("notifications").updateOne({ id: recordId, status: { $ne: "played" } }, { $set: update });
  else await writeRecord("notifications", { ...record, id: recordId, ...update });
}
