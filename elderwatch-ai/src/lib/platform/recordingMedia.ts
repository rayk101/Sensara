import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client } from "../s3";
import { ApiError } from "./auth";
import { recordingSpeech } from "./voice";
import type { SafetyEvent } from "../types";

const run = promisify(execFile);
const MAX_BYTES = 50 * 1024 * 1024;
export interface FinishedRecording {
  durationSeconds: number;
  recordedDurationSeconds: number;
  fileSize: number;
  contentType: string;
  hasAudioTrack: boolean;
  hasEmbeddedVoice: boolean;
  recordingFormatVersion: number;
}
export interface RecordingObject {
  s3Key: string; bucket: string; fileSize: number; contentType: string; processingToken?: string;
}

export async function inspectLocalMedia(file: string) {
  const { stdout, stderr } = await run(process.env.FFMPEG_PATH || ffmpeg || "ffmpeg", [
    "-nostdin", "-hide_banner", "-v", "info", "-xerror", "-protocol_whitelist", "file,pipe", "-i", file,
    "-map", "0:v:0?", "-map", "0:a:0?", "-progress", "pipe:1", "-f", "null", "-",
  ], { timeout: 60000, maxBuffer: 1000000 });
  const times = [...stdout.matchAll(/out_time_us=(\d+)/g)];
  const durationSeconds = Number(times.at(-1)?.[1]) / 1_000_000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 120) throw new Error("Invalid media duration");
  return { durationSeconds, hasAudioTrack: /Stream #0:.*Audio:/.test(stderr), hasVideoTrack: /Stream #0:.*Video:/.test(stderr) };
}

// Keep the entire alert, including when it outlasts a seven-second demo capture.
// A held final frame is represented by recordedDurationSeconds in the UI.
export async function renderRecordingWithVoice(video: Uint8Array, voice: Uint8Array, extension: "webm" | "mp4", recordedDurationSeconds: number) {
  if (!video.length || video.length > MAX_BYTES || !voice.length || voice.length > 5 * 1024 * 1024) throw new ApiError(422, "Invalid recording or alert audio size");
  const directory = await mkdtemp(join(tmpdir(), "sensara-narrated-"));
  try {
    const source = join(directory, `source.${extension}`), narration = join(directory, "alert.mp3"), output = join(directory, `recording.${extension}`);
    await Promise.all([writeFile(source, video, { mode: 0o600 }), writeFile(narration, voice, { mode: 0o600 })]);
    const [original, speech] = await Promise.all([inspectLocalMedia(source), inspectLocalMedia(narration)]);
    if (!original.hasVideoTrack || !speech.hasAudioTrack || speech.durationSeconds > 60) throw new Error("Required media track missing");
    const duration = Math.max(original.durationSeconds, recordedDurationSeconds, speech.durationSeconds + 0.15);
    const voiceFilter = "[1:a:0]asetpts=PTS-STARTPTS,aresample=48000,apad[voice]";
    const audioFilter = original.hasAudioTrack
      ? `${voiceFilter};[0:a:0]asetpts=PTS-STARTPTS,aresample=48000,apad[original];[original][voice]amix=inputs=2:duration=longest:weights='0.65 1':normalize=0,alimiter=limit=0.95:latency=1[audio]`
      : `${voiceFilter};[voice]anull[audio]`;
    await run(process.env.FFMPEG_PATH || ffmpeg || "ffmpeg", [
      "-nostdin", "-hide_banner", "-v", "error", "-xerror", "-y",
      "-protocol_whitelist", "file,pipe", "-i", source, "-protocol_whitelist", "file,pipe", "-i", narration,
      "-filter_complex", audioFilter, "-map", "0:v:0", "-map", "[audio]",
      "-vf", `setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${Math.max(0, duration - recordedDurationSeconds) + 0.25}`,
      ...(extension === "webm" ? ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-crf", "32", "-b:v", "0", "-c:a", "libopus"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]),
      "-threads", "2", "-b:a", "128k", "-t", duration.toFixed(3), output,
    ], { timeout: 120000, maxBuffer: 1000000 });
    const result = await inspectLocalMedia(output);
    const bytes = await readFile(output);
    if (!result.hasVideoTrack || !result.hasAudioTrack || result.durationSeconds + 0.1 < duration || bytes.length > MAX_BYTES) throw new Error("Combined recording is incomplete");
    return { bytes, durationSeconds: result.durationSeconds, recordedDurationSeconds, fileSize: bytes.length,
      contentType: `video/${extension}`, hasAudioTrack: true, hasEmbeddedVoice: true, recordingFormatVersion: 2 };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "Could not combine the complete recording and spoken alert");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function completedRecording(metadata: Record<string, string> | undefined, intent: RecordingObject): FinishedRecording | null {
  // The token is server-only and is never included in the browser upload grant.
  if (!intent.processingToken || metadata?.["sensara-token"] !== intent.processingToken || metadata["recording-version"] !== "2") return null;
  const result = { durationSeconds: Number(metadata.duration), recordedDurationSeconds: Number(metadata["recorded-duration"]),
    fileSize: Number(metadata["file-size"]), contentType: metadata["content-type"], hasAudioTrack: true, hasEmbeddedVoice: true, recordingFormatVersion: 2 };
  if (![result.durationSeconds, result.recordedDurationSeconds, result.fileSize].every(n => Number.isFinite(n) && n > 0)
    || result.durationSeconds > 120 || result.fileSize > MAX_BYTES || !["video/webm", "video/mp4"].includes(result.contentType)) throw new ApiError(422, "Invalid completed recording metadata");
  return result;
}

export function recordingMetadata(result: FinishedRecording, token: string) {
  return { "sensara-token": token, "recording-version": "2", duration: String(result.durationSeconds),
    "recorded-duration": String(result.recordedDurationSeconds), "file-size": String(result.fileSize), "content-type": result.contentType };
}

export async function finishRecording(intent: RecordingObject, event: SafetyEvent, duration: number): Promise<FinishedRecording> {
  const client = getS3Client();
  const object = await client.send(new GetObjectCommand({ Bucket: intent.bucket, Key: intent.s3Key }));
  const completed = completedRecording(object.Metadata, intent);
  if (completed) { if (object.Body && "destroy" in object.Body) object.Body.destroy(); return completed; }
  if (!object.Body || object.ContentLength !== intent.fileSize || object.ContentType !== intent.contentType || !object.ETag || !intent.processingToken) throw new ApiError(422, "Recording changed before audio processing");
  const video = await object.Body.transformToByteArray();
  const speech = await recordingSpeech(event);
  const extension = intent.contentType.startsWith("video/mp4") ? "mp4" : "webm";
  const { bytes, ...result } = await renderRecordingWithVoice(video, speech, extension, duration);
  try {
    // Replace the raw capture at the same key; the bucket only contains one final video.
    await client.send(new PutObjectCommand({ Bucket: intent.bucket, Key: intent.s3Key, Body: bytes, ContentType: result.contentType,
      IfMatch: object.ETag, Metadata: recordingMetadata(result, intent.processingToken) }));
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
    const winner = await client.send(new GetObjectCommand({ Bucket: intent.bucket, Key: intent.s3Key }));
    const saved = completedRecording(winner.Metadata, intent); if (winner.Body && "destroy" in winner.Body) winner.Body.destroy();
    if (!saved) throw error;
    return saved;
  }
  return result;
}
