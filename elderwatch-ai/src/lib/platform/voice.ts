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
const cache = new Map<string, { expires: number; audio: Promise<Uint8Array> }>();
export async function incidentSpeech(id: string) {
  const event = await getSafetyEvent(id);
  if (!event || event.severity !== "urgent" || event.acknowledged || event.status === "resolved") throw new ApiError(404, "Active urgent incident not found");
  const settings = await getSettings();
  if (!settings.voiceEnabled) throw new ApiError(409, "Voice alerts disabled");
  const recordId = `voice:${id}:${currentActor().id}`;
  const existing = await readRecord("notifications", recordId);
  const record = { id: recordId, eventId: id, residentId: event.residentId, staffId: currentActor().id, channel: "voice", provider: "elevenlabs", status: "generating", createdAt: existing?.createdAt ?? new Date().toISOString(), lastAttemptAt: new Date().toISOString(), retryCount: (existing?.retryCount ?? 0) + 1, error: null };
  for (const [key, value] of cache) if (value.expires < Date.now()) cache.delete(key);
  const key = `${id}:${process.env.ELEVENLABS_VOICE_ID}:${settings.dataMode}`;
  let value = cache.get(key);
  if (!value) { if (cache.size >= 20) cache.delete(cache.keys().next().value!); value = { expires: Date.now() + 300_000, audio: generateSpeech(voiceText(event, settings.dataMode === "demo")) }; cache.set(key, value); }
  try {
    const audio = await value.audio;
    await writeRecord("notifications", { ...record, status: "generated" });
    return audio;
  } catch (error) {
    cache.delete(key);
    await writeRecord("notifications", { ...record, status: "failed", error: "Speech generation failed" });
    throw error;
  }
}
export async function recordVoicePlayback(id: string, status: string) {
  const event = await getSafetyEvent(id);
  if (!event) throw new ApiError(404, "Incident not found");
  if (!["played", "blocked", "playback_failed"].includes(status)) throw new ApiError(400, "Invalid playback status");
  const recordId = `voice:${id}:${currentActor().id}`;
  const record = await readRecord("notifications", recordId);
  if (!record) throw new ApiError(409, "Generate speech before reporting playback");
  await writeRecord("notifications", { ...record, id: recordId, status, lastAttemptAt: new Date().toISOString() });
}
