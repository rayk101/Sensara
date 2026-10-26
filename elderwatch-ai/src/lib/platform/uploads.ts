import { verifyUploadedMedia } from "./media";
import { clipPolicy, clipObjectKey, recordingSource } from "../clipPolicy";
import { completedRecording, finishRecording } from "./recordingMedia";
import { getResidentById } from "../db/residents";
import { randomUUID } from "node:crypto";
import { getSafetyEvent, linkVideoClipToEvent } from "../db/events";
import { createVideoClip, getVideoClipById } from "../db/videoClips";
import { isS3Configured, getS3Bucket, createPresignedUploadUrl, inspectUploadedObject } from "../s3";
import { ApiError, assertPatient } from "./auth";
import { identifier, isoTime } from "./validation";
import { getSettings } from "./settings";
import { memory, readRecord } from "./store";
import { getDb, isMongoEnabled } from "../mongodb";
export const MAX_CLIP_BYTES = 50 * 1024 * 1024;
export interface UploadIntent { id: string; eventId: string; residentId: string; s3Key: string; bucket: string; contentType: string; fileSize: number; status: "pending" | "uploaded"; createdAt: string; expiresAt: string; clipId?: string; processingToken?: string }
export function validateClipFile(contentType: unknown, size: unknown) {
  if (typeof contentType !== "string" || !/^(video\/webm|video\/mp4)(;codecs=[a-zA-Z0-9., -]+)?$/.test(contentType)) throw new ApiError(400, "Only WebM or MP4 video clips are allowed");
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_CLIP_BYTES) throw new ApiError(400, "Clip must be between 1 byte and 50 MB");
  return { contentType, fileSize: size, extension: contentType.startsWith("video/mp4") ? "mp4" : "webm" };
}
export async function prepareUpload(input: Record<string, unknown>) {
  if (!isS3Configured()) throw new ApiError(503, "S3 is not configured");
  const file = validateClipFile(input.contentType, input.fileSize);
  const eventId = identifier(input.eventId, "incident");
  const event = await getSafetyEvent(eventId);
  if (!event || event.residentId !== input.residentId || event.severity !== "urgent") throw new ApiError(404, "Matching urgent incident not found");
  if (!recordingSource(event)) throw new ApiError(400, "Only incidents from a camera monitoring session can upload recordings");
  if (event.workflow?.video.status === "removed") throw new ApiError(409, "This recording was removed");
  const settings = await getSettings();
  if (!settings.recordingEnabled || (await getResidentById(event.residentId))?.monitoringConfig?.recordingEnabled === false) throw new ApiError(409, "Recording is disabled");
  if (event.hasVideoClip) throw new ApiError(409, "Incident already has a clip");
  const id = randomUUID();
  const intent: UploadIntent = { id, eventId, residentId: event.residentId, ...file,
    s3Key: clipObjectKey(event, file.extension as "mp4" | "webm"), bucket: getS3Bucket(), processingToken: randomUUID(),
    status: "pending", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() };
  let saved: UploadIntent;
  if (!isMongoEnabled()) {
    const prior = [...memory("upload_intents").values()].find(i => i.eventId === eventId) as UploadIntent | undefined;
    saved = prior ?? intent; memory("upload_intents").set(saved.id, saved);
  } else {
    const col = (await getDb()).collection<UploadIntent>("upload_intents");
    await col.updateOne({ eventId }, { $setOnInsert: intent }, { upsert: true });
    saved = (await col.findOne({ eventId }))!;
  }
  if (saved.s3Key !== intent.s3Key || saved.fileSize !== file.fileSize || saved.contentType !== file.contentType || saved.status !== "pending" || Date.parse(saved.expiresAt) < Date.now()) throw new ApiError(409, "Upload intent conflicts with this recording or has expired");
  return { uploadId: saved.id, s3Key: saved.s3Key, bucket: saved.bucket,
    uploadUrl: await createPresignedUploadUrl({ key: saved.s3Key, contentType: saved.contentType, fileSize: saved.fileSize }),
    headers: { "Content-Type": saved.contentType, "If-None-Match": "*" } };
}
export async function completeUpload(input: Record<string, unknown>, inspect: (key: string) => Promise<{ size?: number; type?: string; metadata?: Record<string, string>; bytes?: Uint8Array }> = inspectUploadedObject, verify = verifyUploadedMedia, enhance = finishRecording) {
  const id = identifier(input.uploadId, "upload");
  const intent = await readRecord<UploadIntent>("upload_intents", id);
  if (!intent) throw new ApiError(404, "Upload not found");
  assertPatient(intent.residentId);
  if (input.eventId !== intent.eventId || input.residentId !== intent.residentId) throw new ApiError(400, "Upload patient or incident mismatch");
  const event = await getSafetyEvent(intent.eventId);
  if (!event) throw new ApiError(404, "Incident not found");
  if (intent.clipId) return { ...await getVideoClipById(intent.clipId), event };
  const source = recordingSource(event);
  if (!source) throw new ApiError(400, "Only incidents from a camera monitoring session can upload recordings");
  if (intent.s3Key !== clipObjectKey(event, intent.contentType.startsWith("video/mp4") ? "mp4" : "webm")) throw new ApiError(409, "Recording destination does not match its camera source");
  if (Date.parse(intent.expiresAt) < Date.now()) throw new ApiError(409, "Upload verification expired");
  const start = isoTime(input.clipStartTime), end = isoTime(input.clipEndTime);
  const duration = (Date.parse(end) - Date.parse(start)) / 1000;
  const policy = clipPolicy(source);
  if (duration < policy.minSeconds || duration > policy.maxSeconds || Date.parse(start) < Date.parse(event.firstUrgentAt ?? event.createdAt) - 1000 || Date.parse(end) > Date.now() + 10_000) throw new ApiError(400, `Expected approximately ${policy.seconds} seconds of post-event footage`);
  // Older, still-pending captures can finish after a deploy without losing their identity.
  if (!intent.processingToken) {
    const token = randomUUID();
    if (!isMongoEnabled()) intent.processingToken = token;
    else {
      const col = (await getDb()).collection<UploadIntent>("upload_intents");
      await col.updateOne({ id, processingToken: { $exists: false } }, { $set: { processingToken: token } });
      intent.processingToken = (await col.findOne({ id }))!.processingToken;
    }
  }
  const object = await inspect(intent.s3Key);
  let recording = completedRecording(object.metadata, intent);
  if (recording && (object.size !== recording.fileSize || object.type !== recording.contentType)) throw new ApiError(422, "Completed recording has changed");
  if (!recording) {
    const bytes = object.bytes;
    const validContainer = intent.contentType.startsWith("video/webm") ? bytes?.[0] === 0x1a && bytes?.[1] === 0x45 && bytes?.[2] === 0xdf && bytes?.[3] === 0xa3 : bytes && Buffer.from(bytes.slice(4, 8)).toString() === "ftyp";
    if (object.size !== intent.fileSize || object.type !== intent.contentType || !validContainer) throw new ApiError(400, "Uploaded object does not match the approved video");
    const mediaDuration = await verify(intent.s3Key, policy);
    if (!Number.isFinite(mediaDuration) || mediaDuration < policy.minSeconds || mediaDuration > policy.maxSeconds) throw new ApiError(422, `Expected a complete ${policy.seconds}-second clip`);
    recording = await enhance(intent, event, mediaDuration);
  }
  if (!recording.hasEmbeddedVoice || !recording.hasAudioTrack || recording.recordedDurationSeconds < policy.minSeconds || recording.recordedDurationSeconds > policy.maxSeconds) throw new ApiError(422, "A complete recording with spoken alert is required");
  const settings = await getSettings();
  const clip = await createVideoClip({ eventId: intent.eventId, residentId: event.residentId, residentName: event.residentName, room: event.room,
    severity: event.severity, eventType: event.eventType, s3Key: intent.s3Key, fileName: intent.s3Key.split("/").at(-1), bucket: intent.bucket, ...recording,
    uploadStatus: "uploaded", uploadedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + settings.retentionDays * 86400_000).toISOString(),
    footageType: "post-event", clipStartTime: start, clipEndTime: end,
    hasVideoTrack: true, createdAt: new Date().toISOString() });
  const updated = await linkVideoClipToEvent(intent.eventId, clip._id!, { s3Key: clip.s3Key, fileName: clip.fileName, bucket: clip.bucket, contentType: clip.contentType,
    durationSeconds: clip.durationSeconds, recordedDurationSeconds: clip.recordedDurationSeconds, hasEmbeddedVoice: true, clipStartTime: start, clipEndTime: end });
  const update = { status: "uploaded", clipId: clip._id };
  if (!isMongoEnabled()) Object.assign(intent, update);
  else await (await getDb()).collection("upload_intents").updateOne({ id }, { $set: update });
  return { ...clip, event: updated };
}
