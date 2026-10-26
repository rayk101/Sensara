import { createHash, randomUUID } from "node:crypto";
import { getResidentById } from "../db/residents";
import { createSafetyEvent } from "../db/events";
import { getDb, getMongoClient, isMongoEnabled } from "../mongodb";
import { EventType, ResidentStatus, type SafetyEvent, type SafetySignals } from "../types";
import { RECOMMENDED_ACTIONS } from "../classifySafety";
import { ApiError, assertPatient, currentActor } from "./auth";
import { getSession } from "./sessions";
import { identifier, text, isoTime } from "./validation";
import { DEMO_SCENARIOS } from "../demoScenarios";
import { getCaregivers, getSettings } from "./settings";
import { getInMemoryStore } from "../mockData";
import { analyzePoseWindow, validatePoseFrames } from "../poseEvidence";
import { memory } from "./store";
import { ObjectId } from "mongodb";
import { recordingSource as eventRecordingSource } from "../clipPolicy";
export function episodeCategory(type: string) { return ["possible_fall", "fall_risk", "unsafe_posture"].includes(type) ? "fall" : type; }
const locks = new Map<string, Promise<unknown>>();
export async function submitIncident(input: Record<string, unknown>): Promise<SafetyEvent> {
  const event = await submitDetection(input);
  if (!event) throw new ApiError(400, "Observation does not require an incident");
  return event;
}
export async function submitDetection(input: Record<string, unknown>): Promise<SafetyEvent | null> {
  const key = String(input.residentId);
  const previous = locks.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await ingestIncident(input); }
      catch (error) { if (attempt >= 2 || (error as { code?: number }).code !== 11000) throw error; }
    }
  });
  locks.set(key, operation);
  try { return await operation; } finally { if (locks.get(key) === operation) locks.delete(key); }
}
async function ingestIncident(input: Record<string, unknown>): Promise<SafetyEvent | null> {
  const residentId = identifier(input.residentId, "patient");
  assertPatient(residentId);
  const patient = await getResidentById(residentId);
  if (!patient || patient.active === false) throw new ApiError(404, "Active patient not found");
  if (input.source === "multi_feed_demo") {
    const scenario = DEMO_SCENARIOS.find(s => s.id === input.scenarioId && s.residentId === residentId);
    if (!scenario || typeof input.videoTime !== "number" || !Number.isFinite(input.videoTime) || input.videoTime < 0 || input.videoTime > 3600) throw new ApiError(400, "Invalid demo scenario evidence");
    try {
      const measured = analyzePoseWindow(validatePoseFrames(input.poseFrames, input.videoTime));
      input = { ...input, ...measured };
    } catch { throw new ApiError(400, "Valid body-tracking evidence is required; video time alone cannot trigger an alert"); }
  } else if ((input.source ?? "live_camera") === "live_camera") {
    try {
      if (typeof input.videoTime !== "number" || !Number.isFinite(input.videoTime) || input.videoTime < 0) throw new Error();
      const aspect = input.aspect;
      if (typeof aspect !== "number" || !Number.isFinite(aspect) || aspect < .25 || aspect > 4) throw new Error();
      // Zone coordinates are a camera configuration, never patient identity or a recipient.
      const zone = input.safeZone as import("../types").SafeZone | undefined;
      if (zone && (!Number.isFinite(zone.x) || !Number.isFinite(zone.width) || zone.x < 0 || zone.width <= 0 || zone.x + zone.width > 1)) throw new Error();
      input = { ...input, ...analyzePoseWindow(validatePoseFrames(input.poseFrames, input.videoTime), aspect, zone) };
    } catch { throw new ApiError(400, "Valid camera body-tracking evidence is required"); }
  }
  if (!Object.values(ResidentStatus).includes(input.severity as never) ||
      !Object.values(EventType).includes(input.eventType as never)) throw new ApiError(400, "Invalid incident classification");
  if (typeof input.confidence !== "number" || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new ApiError(400, "Invalid confidence");
  const source = input.source ?? "live_camera";
  if (!["live_camera", "audio_monitor", "manual", "multi_feed_demo"].includes(String(source))) throw new ApiError(400, "Invalid incident source");
  const sessionId = input.sessionId ? identifier(input.sessionId, "session") : null;
  let recordingSource: SafetyEvent["recordingSource"];
  if (sessionId) {
    const session = await getSession(sessionId);
    if (!session || session.residentId !== residentId || session.status !== "active" || Date.parse(session.lastSeenAt) < Date.now() - 90_000) throw new ApiError(409, "Monitoring session is not active for this patient");
    if (session.staffId !== currentActor().id && currentActor().role !== "admin") throw new ApiError(403, "Session belongs to another user");
    if ((source === "live_camera" && session.source !== "live_camera") || (source === "multi_feed_demo" && (session.source !== "multi_feed_demo" || session.deviceId !== input.scenarioId))) throw new ApiError(400, "Monitoring source mismatch");
    if (source !== "audio_monitor") recordingSource = session.source;
  } else if (source === "live_camera" || source === "multi_feed_demo") throw new ApiError(400, "An active monitoring session is required");
  const signals = (input.signals ?? { isLyingDown: false, movementScore: 0, postureAngle: 0, secondsStill: 0, insideSafeZone: true, visible: false }) as SafetySignals;
  if (!signals || typeof signals !== "object" || ["isLyingDown", "insideSafeZone", "visible"].some(key => typeof (signals as unknown as Record<string, unknown>)[key] !== "boolean") || [signals.movementScore, signals.postureAngle, signals.secondsStill].some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)) throw new ApiError(400, "Invalid safety signals");
  for (const [key, value] of Object.entries(signals)) {
    if (["secondsOutsideSafeZone", "secondsHighMovement", "handsNearThroatSeconds", "secondsLyingDown", "secondsBadPosture", "secondsSlumped", "majorBodyMovementScore"].includes(key) && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new ApiError(400, "Invalid detector timing evidence");
  }
  const requestId = text(input.sourceEventId ?? input.idempotencyKey, "source event ID", 200);
  const detectedAt = isoTime(input.detectedAt ?? new Date().toISOString());
  if (Date.parse(detectedAt) > Date.now() + 10_000 || Date.parse(detectedAt) < Date.now() - 120_000) throw new ApiError(409, "Observation is stale or from the future");
  const settings = await getSettings();
  const recipients = (await getCaregivers()).filter(r => r.active && r.urgentAlerts && r.patientIds.includes(residentId)).map(r => r.id);
  const urgent = input.severity === "urgent";
  const episodePrefix = `${residentId}:${episodeCategory(String(input.eventType))}`;
  const origin = recordingSource ?? String(source);
  const activeEpisodeKey = `${episodePrefix}:${origin}`;
  const sameOrigin = (prior: SafetyEvent) => (eventRecordingSource(prior) ?? prior.source) === origin;
  const originFilter = { $or: [{ recordingSource: origin }, { recordingSource: null, source: origin }] };
  const idempotencyKey = createHash("sha256").update(`${residentId}:${sessionId ?? "manual"}:${requestId}`).digest("hex");
  const now = new Date().toISOString();
  const observed = (source === "live_camera" || source === "multi_feed_demo") && input.available !== true ? "unknown" : String(input.severity);
  const observation = (prior: Record<string, unknown> | null | undefined) => {
    // This window stabilizes the UI and rearms episodes; it makes no safety claim.
    const normalSince = observed === "stable" ? (typeof prior?.normalSince === "string" ? prior.normalSince : detectedAt) : null;
    const severity = observed === "stable" && prior && ["watch", "assist"].includes(String(prior.severity)) && Date.parse(detectedAt) - Date.parse(normalSince!) < 5000 ? prior.severity : observed;
    // Fresh, observed non-critical frames can establish a new occurrence even
    // while the earlier care incident remains unresolved. Missing tracking cannot.
    const nonUrgent = input.available === true && signals.visible && !urgent;
    const continuous = prior?.sessionId === sessionId && typeof prior.detectedAt === "string" && Date.parse(detectedAt) - Date.parse(prior.detectedAt) <= 2000;
    const nonUrgentSince = nonUrgent ? (continuous && typeof prior?.nonUrgentSince === "string" ? prior.nonUrgentSince : detectedAt) : null;
    return { id: residentId, sessionId, detectedAt, severity, normalSince, nonUrgentSince };
  };
  const newOccurrence = (prior: SafetyEvent, latest: Record<string, unknown> | null | undefined) => {
    if (urgent && prior.firstUrgentAt && source === "manual" && recordingSource && input.manualTrigger === true) return true;
    if (!urgent || !prior.firstUrgentAt || !["live_camera", "multi_feed_demo"].includes(String(source))) return false;
    const lastUrgent = Date.parse(prior.lastUrgentAt ?? prior.firstUrgentAt);
    const recovered = latest?.sessionId === sessionId && typeof latest.nonUrgentSince === "string" && typeof latest.detectedAt === "string"
      && Date.parse(latest.nonUrgentSince) > lastUrgent
      && Date.parse(latest.detectedAt) - Date.parse(latest.nonUrgentSince) >= 2000
      && Date.parse(detectedAt) - Date.parse(latest.detectedAt) <= 2000;
    // Starting a fresh session after a gap must not reuse yesterday's clip.
    // A quick refresh during the same ongoing warning still deduplicates.
    const freshSession = sessionId !== prior.sessionId && Date.parse(detectedAt) - lastUrgent >= 30_000;
    return recovered || freshSession;
  };
  const rearmed = (prior: Record<string, unknown> | null | undefined, closedAt: string) => source === "manual" || !!(typeof prior?.normalSince === "string" && typeof prior.detectedAt === "string" && prior.detectedAt >= closedAt && Date.parse(detectedAt) - Date.parse(prior.normalSince) >= 5000);
  const event: Omit<SafetyEvent, "_id"> = { residentId, residentName: patient.name, room: patient.room,
    eventType: input.eventType as SafetyEvent["eventType"], severity: input.severity as SafetyEvent["severity"], confidence: input.confidence,
    reason: text(input.reason, "reason", 2000), recommendedAction: RECOMMENDED_ACTIONS[String(input.eventType)] ?? "Check the resident and follow facility response procedures.",
    ...(["multi_feed_demo", "live_camera"].includes(String(source)) ? { detectionMethod: "mediapipe_pose_v1" as const } : {}),
    signals, source: source as SafetyEvent["source"], ...(recordingSource ? { recordingSource } : {}), sessionId, idempotencyKey, status: "open", initialStatus: "open",
    version: 1, episodeId: randomUUID(), activeEpisodeKey, sourceEventId: requestId, correlationId: randomUUID(), detectedAt,
    firstUrgentAt: urgent ? now : null, lastUrgentAt: urgent ? detectedAt : null,
    workflow: {
      video: { status: urgent && recordingSource && settings.recordingEnabled && patient.monitoringConfig?.recordingEnabled !== false ? "requested" : "not_requested", updatedAt: now },
      voice: { status: urgent && settings.voiceEnabled ? "queued" : "not_requested", updatedAt: now },
      messaging: { status: !urgent || !settings.notificationsEnabled ? "disabled" : recipients.length ? "queued" : "configuration_failed", recipientIds: recipients, updatedAt: now },
      dashboard: { status: "available", updatedAt: now },
    },
    stateHistory: [{ status: "open", at: now, by: currentActor().id }], notificationsQueued: false,
    acknowledged: false, acknowledgedBy: null, acknowledgedAt: null, resolvedAt: null, createdAt: now,
    hasVideoClip: false, videoClipId: null, videoClip: null,
    ...(typeof input.audioTranscript === "string" ? { audioTranscript: input.audioTranscript.slice(0, 5000) } : {}) };
  const merge = (prior: SafetyEvent): Partial<SafetyEvent> => {
    if (!urgent) return {};
    if (prior.firstUrgentAt) return { lastUrgentAt: detectedAt };
    return { severity: "urgent", eventType: event.eventType, confidence: event.confidence, reason: event.reason,
      recommendedAction: event.recommendedAction, detectionMethod: event.detectionMethod, signals: event.signals, source: event.source, ...(event.recordingSource ? { recordingSource: event.recordingSource } : {}), sessionId: event.sessionId, firstUrgentAt: now, lastUrgentAt: detectedAt, workflow: event.workflow, notificationsQueued: false };
  };
  if (!isMongoEnabled()) {
    const ingestion = memory("event_ingestions").get(idempotencyKey);
    if (ingestion) return ingestion.incidentId ? getInMemoryStore().getEventById(ingestion.incidentId)! : null;
    const latest = memory("monitoring_observations").get(residentId);
    if (latest && detectedAt < latest.detectedAt) throw new ApiError(409, "Out-of-order observation");
    if (input.severity === "stable") {
      memory("monitoring_observations").set(residentId, observation(latest));
      memory("event_ingestions").set(idempotencyKey, { id: idempotencyKey, incidentId: null });
      return null;
    }
    let prior = getInMemoryStore().getRecentEvents(100000).find(e => sameOrigin(e) && (e.activeEpisodeKey === episodePrefix || e.activeEpisodeKey?.startsWith(`${episodePrefix}:`)));
    if (prior && newOccurrence(prior, latest)) {
      event.recurrenceOf = prior._id;
      event.activeEpisodeKey = `${activeEpisodeKey}:${event.episodeId}`;
      delete prior.activeEpisodeKey;
      prior.version = (prior.version ?? 0) + 1;
      prior = undefined;
    }
    const closed = getInMemoryStore().getRecentEvents(100000).find(e => sameOrigin(e) && e.residentId === residentId && episodeCategory(e.eventType) === episodeCategory(event.eventType) && e.resolvedAt && (e.resolvedAt >= detectedAt || !rearmed(latest, e.resolvedAt)));
    if (closed && !prior && !event.recurrenceOf) throw new ApiError(409, "Delayed observation for a closed episode");
    let saved: SafetyEvent;
    if (prior) { const update = merge(prior); if (Object.keys(update).length) { const promoted = !prior.firstUrgentAt; Object.assign(prior, update); prior.version = (prior.version ?? 0) + 1; if (promoted) prior.stateHistory?.push({ status: "urgent", at: now, by: currentActor().id }); } saved = prior; }
    else saved = await createSafetyEvent(event);
    memory("event_ingestions").set(idempotencyKey, { id: idempotencyKey, incidentId: saved!._id });
    memory("monitoring_observations").set(residentId, observation(latest));
    return saved;
  }
  const client = await getMongoClient(), db = await getDb();
  const session = client.startSession();
  try {
    return (await session.withTransaction(async () => {
      const ingestions = db.collection("event_ingestions");
      const duplicate = await ingestions.findOne({ id: idempotencyKey }, { session });
      if (duplicate) {
        if (!duplicate.incidentId) return null;
        const stored = await db.collection("safety_events").findOne({ _id: duplicate.incidentId }, { session });
        return { ...stored, _id: stored!._id.toString() } as unknown as SafetyEvent;
      }
      if (sessionId) {
        const active = await db.collection("monitoring_sessions").findOne({ id: sessionId, residentId, status: "active", lastSeenAt: { $gte: new Date(Date.now() - 90000).toISOString() } }, { session });
        if (!active || (active.staffId !== currentActor().id && currentActor().role !== "admin")) throw new ApiError(409, "Monitoring session is unavailable or belongs to another user");
      }
      const observations = db.collection("monitoring_observations");
      const latest = await observations.findOne({ id: residentId }, { session });
      if (latest && detectedAt < latest.detectedAt) throw new ApiError(409, "Out-of-order observation");
      if (input.severity === "stable") {
        await observations.updateOne({ id: residentId }, { $set: observation(latest) }, { upsert: true, session });
        await ingestions.insertOne({ id: idempotencyKey, incidentId: null, residentId, sourceEventId: requestId, detectedAt }, { session });
        return null;
      }
      const col = db.collection("safety_events");
      let prior = await col.findOne({ residentId, ...originFilter, activeEpisodeKey: { $regex: `^${episodePrefix}(?::|$)` } }, { session });
      if (prior && newOccurrence(prior as unknown as SafetyEvent, latest)) {
        event.recurrenceOf = prior._id.toString();
        // A new key also avoids recycling a unique-index value inside a transaction.
        event.activeEpisodeKey = `${activeEpisodeKey}:${event.episodeId}`;
        await col.updateOne({ _id: prior._id }, { $unset: { activeEpisodeKey: "" }, $inc: { version: 1 } }, { session });
        prior = null;
      }
      const closed = await col.findOne({ residentId, ...originFilter, episodeCategory: episodeCategory(event.eventType), resolvedAt: { $type: "string" } }, { session, sort: { resolvedAt: -1 } });
      if (!prior && !event.recurrenceOf && closed && (closed.resolvedAt >= detectedAt || !rearmed(latest, closed.resolvedAt))) throw new ApiError(409, "Delayed observation for a closed episode");
      const id = prior?._id ?? new ObjectId();
      if (prior) {
        const update = merge(prior as unknown as SafetyEvent);
        if (Object.keys(update).length) await col.updateOne({ _id: id, version: prior.version }, { $set: update, $inc: { version: 1 }, ...(!prior.firstUrgentAt ? { $push: { stateHistory: { status: "urgent", at: now, by: currentActor().id } } } : {}) } as object, { session });
      } else await col.insertOne({ ...event, _id: id, episodeCategory: episodeCategory(event.eventType) }, { session });
      await observations.updateOne({ id: residentId }, { $set: observation(latest) }, { upsert: true, session });
      await ingestions.insertOne({ id: idempotencyKey, incidentId: id, residentId, sourceEventId: requestId, detectedAt }, { session });
      if (sessionId) await db.collection("monitoring_sessions").updateOne({ id: sessionId, residentId }, { $set: { lastObservedEventAt: detectedAt, state: event.severity } }, { session });
      const saved = (await col.findOne({ _id: id }, { session }))!;
      return { ...saved, _id: saved._id.toString() } as unknown as SafetyEvent;
    }));
  } finally { await session.endSession(); }
}
