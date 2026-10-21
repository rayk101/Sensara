import { createHash, randomUUID } from "node:crypto";
import { getResidentById } from "../db/residents";
import { createSafetyEvent } from "../db/events";
import { getDb, getMongoClient, isMongoEnabled } from "../mongodb";
import { EventType, ResidentStatus, type SafetyEvent, type SafetySignals } from "../types";
import { RECOMMENDED_ACTIONS } from "../classifySafety";
import { ApiError, assertPatient, currentActor } from "./auth";
import { getSession } from "./sessions";
import { identifier, text, isoTime } from "./validation";
import { getCaregivers, getSettings } from "./settings";
import { getInMemoryStore } from "../mockData";
import { memory } from "./store";
import { ObjectId } from "mongodb";
export function episodeCategory(type: string) { return ["possible_fall", "fall_risk", "unsafe_posture"].includes(type) ? "fall" : type; }
const locks = new Map<string, Promise<unknown>>();
export async function submitIncident(input: Record<string, unknown>): Promise<SafetyEvent> {
  const key = String(input.residentId);
  const previous = locks.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => ingestIncident(input));
  locks.set(key, operation);
  try { return await operation; } finally { if (locks.get(key) === operation) locks.delete(key); }
}
async function ingestIncident(input: Record<string, unknown>): Promise<SafetyEvent> {
  const residentId = identifier(input.residentId, "patient");
  assertPatient(residentId);
  const patient = await getResidentById(residentId);
  if (!patient || patient.active === false) throw new ApiError(404, "Active patient not found");
  if (!Object.values(ResidentStatus).includes(input.severity as never) || input.severity === "stable" ||
      !Object.values(EventType).includes(input.eventType as never) || input.eventType === "normal") throw new ApiError(400, "Invalid incident classification");
  if (typeof input.confidence !== "number" || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new ApiError(400, "Invalid confidence");
  const source = input.source ?? "live_camera";
  if (!["live_camera", "audio_monitor", "manual", "multi_feed_demo"].includes(String(source))) throw new ApiError(400, "Invalid incident source");
  const sessionId = input.sessionId ? identifier(input.sessionId, "session") : null;
  if (sessionId) {
    const session = await getSession(sessionId);
    if (!session || session.residentId !== residentId || session.status !== "active" || Date.parse(session.lastSeenAt) < Date.now() - 90_000) throw new ApiError(409, "Monitoring session is not active for this patient");
    if (source === "live_camera" && session.source !== "live_camera") throw new ApiError(400, "Monitoring source mismatch");
  } else if (source === "live_camera" || source === "multi_feed_demo") throw new ApiError(400, "An active monitoring session is required");
  const signals = (input.signals ?? { isLyingDown: false, movementScore: 0, postureAngle: 0, secondsStill: 0, insideSafeZone: true, visible: false }) as SafetySignals;
  if (!signals || typeof signals !== "object" || ["isLyingDown", "insideSafeZone", "visible"].some(key => typeof (signals as unknown as Record<string, unknown>)[key] !== "boolean") || [signals.movementScore, signals.postureAngle, signals.secondsStill].some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)) throw new ApiError(400, "Invalid safety signals");
  const requestId = text(input.sourceEventId ?? input.idempotencyKey, "source event ID", 200);
  const detectedAt = isoTime(input.detectedAt ?? new Date().toISOString());
  if (Date.parse(detectedAt) > Date.now() + 10_000 || Date.parse(detectedAt) < Date.now() - 120_000) throw new ApiError(409, "Observation is stale or from the future");
  const settings = await getSettings();
  const recipients = (await getCaregivers()).filter(r => r.active && r.urgentAlerts && r.patientIds.includes(residentId)).map(r => r.id);
  const urgent = input.severity === "urgent";
  const activeEpisodeKey = `${residentId}:${episodeCategory(String(input.eventType))}`;
  const idempotencyKey = createHash("sha256").update(`${residentId}:${sessionId ?? "manual"}:${input.eventType}:${input.severity}:${requestId}`).digest("hex");
  const now = new Date().toISOString();
  const event: Omit<SafetyEvent, "_id"> = { residentId, residentName: patient.name, room: patient.room,
    eventType: input.eventType as SafetyEvent["eventType"], severity: input.severity as SafetyEvent["severity"], confidence: input.confidence,
    reason: text(input.reason, "reason", 2000), recommendedAction: RECOMMENDED_ACTIONS[String(input.eventType)] ?? "Check the resident and follow facility response procedures.",
    signals, source: source as SafetyEvent["source"], sessionId, idempotencyKey, status: "open", initialStatus: "open",
    version: 1, episodeId: randomUUID(), activeEpisodeKey, sourceEventId: requestId, correlationId: randomUUID(), detectedAt,
    firstUrgentAt: urgent ? now : null,
    workflow: {
      video: { status: urgent && settings.recordingEnabled ? "requested" : "not_requested", updatedAt: now },
      voice: { status: urgent && settings.voiceEnabled ? "queued" : "not_requested", updatedAt: now },
      messaging: { status: !urgent || !settings.notificationsEnabled ? "disabled" : recipients.length ? "queued" : "configuration_failed", recipientIds: recipients, updatedAt: now },
      dashboard: { status: "available", updatedAt: now },
    },
    stateHistory: [{ status: "open", at: now, by: currentActor().id }], notificationsQueued: false,
    acknowledged: false, acknowledgedBy: null, acknowledgedAt: null, resolvedAt: null, createdAt: now,
    hasVideoClip: false, videoClipId: null, videoClip: null,
    ...(typeof input.audioTranscript === "string" ? { audioTranscript: input.audioTranscript.slice(0, 5000) } : {}) };
  const merge = (prior: SafetyEvent): Partial<SafetyEvent> => {
    if (prior.firstUrgentAt || !urgent) return {};
    return { severity: "urgent", eventType: event.eventType, confidence: event.confidence, reason: event.reason,
      recommendedAction: event.recommendedAction, firstUrgentAt: now, workflow: event.workflow, notificationsQueued: false };
  };
  if (!isMongoEnabled()) {
    const ingestion = memory("event_ingestions").get(idempotencyKey);
    if (ingestion) return getInMemoryStore().getEventById(ingestion.incidentId)!;
    const latest = memory("monitoring_observations").get(residentId);
    if (latest && detectedAt < latest.detectedAt) throw new ApiError(409, "Out-of-order observation");
    const prior = getInMemoryStore().getRecentEvents(100000).find(e => e.activeEpisodeKey === activeEpisodeKey);
    const closed = getInMemoryStore().getRecentEvents(100000).find(e => e.residentId === residentId && episodeCategory(e.eventType) === episodeCategory(event.eventType) && e.resolvedAt && e.resolvedAt >= detectedAt);
    if (closed) throw new ApiError(409, "Delayed observation for a closed episode");
    let saved: SafetyEvent;
    if (prior) { const update = merge(prior); if (Object.keys(update).length) { Object.assign(prior, update); prior.version = (prior.version ?? 0) + 1; prior.stateHistory?.push({ status: "urgent", at: now, by: currentActor().id }); } saved = prior; }
    else saved = await createSafetyEvent(event);
    memory("event_ingestions").set(idempotencyKey, { id: idempotencyKey, incidentId: saved._id });
    memory("monitoring_observations").set(residentId, { id: residentId, detectedAt, severity: input.severity });
    return saved;
  }
  const client = await getMongoClient(), db = await getDb();
  const session = client.startSession();
  try {
    return (await session.withTransaction(async () => {
      const ingestions = db.collection("event_ingestions");
      const duplicate = await ingestions.findOne({ id: idempotencyKey }, { session });
      if (duplicate) {
        const stored = await db.collection("safety_events").findOne({ _id: duplicate.incidentId }, { session });
        return { ...stored, _id: stored!._id.toString() } as unknown as SafetyEvent;
      }
      const observations = db.collection("monitoring_observations");
      const latest = await observations.findOne({ id: residentId }, { session });
      if (latest && detectedAt < latest.detectedAt) throw new ApiError(409, "Out-of-order observation");
      const col = db.collection("safety_events");
      const closed = await col.findOne({ residentId, episodeCategory: episodeCategory(event.eventType), resolvedAt: { $gte: detectedAt } }, { session });
      if (closed) throw new ApiError(409, "Delayed observation for a closed episode");
      const prior = await col.findOne({ activeEpisodeKey }, { session });
      const id = prior?._id ?? new ObjectId();
      if (prior) {
        const update = merge(prior as unknown as SafetyEvent);
        if (Object.keys(update).length) await col.updateOne({ _id: id, version: prior.version }, { $set: update, $inc: { version: 1 }, $push: { stateHistory: { status: "urgent", at: now, by: currentActor().id } } } as object, { session });
      } else await col.insertOne({ ...event, _id: id, episodeCategory: episodeCategory(event.eventType) }, { session });
      await observations.updateOne({ id: residentId }, { $set: { id: residentId, sessionId, detectedAt, severity: event.severity } }, { upsert: true, session });
      await ingestions.insertOne({ id: idempotencyKey, incidentId: id, residentId, sourceEventId: requestId, detectedAt }, { session });
      if (sessionId) await db.collection("monitoring_sessions").updateOne({ id: sessionId, residentId }, { $set: { lastObservedEventAt: detectedAt, state: event.severity } }, { session });
      const saved = (await col.findOne({ _id: id }, { session }))!;
      return { ...saved, _id: saved._id.toString() } as unknown as SafetyEvent;
    }))!;
  } finally { await session.endSession(); }
}
