import { createHash, randomUUID } from "node:crypto";
import { getResidentById } from "../db/residents";
import { createSafetyEvent } from "../db/events";
import { getDb, isMongoEnabled } from "../mongodb";
import { EventType, ResidentStatus, type SafetyEvent, type SafetySignals } from "../types";
import { RECOMMENDED_ACTIONS } from "../classifySafety";
import { ApiError, assertPatient, currentActor } from "./auth";
import { getSession } from "./sessions";
import { identifier, text } from "./validation";
export async function submitIncident(input: Record<string, unknown>): Promise<SafetyEvent> {
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
  const requestId = input.idempotencyKey ? text(input.idempotencyKey, "idempotency key", 200) : randomUUID();
  const idempotencyKey = createHash("sha256").update(`${residentId}:${sessionId ?? "manual"}:${input.eventType}:${input.severity}:${requestId}`).digest("hex");
  const now = new Date().toISOString();
  const event: Omit<SafetyEvent, "_id"> = { residentId, residentName: patient.name, room: patient.room,
    eventType: input.eventType as SafetyEvent["eventType"], severity: input.severity as SafetyEvent["severity"], confidence: input.confidence,
    reason: text(input.reason, "reason", 2000), recommendedAction: RECOMMENDED_ACTIONS[String(input.eventType)] ?? "Check the resident and follow facility response procedures.",
    signals, source: source as SafetyEvent["source"], sessionId, idempotencyKey, status: "open", initialStatus: "open",
    stateHistory: [{ status: "open", at: now, by: currentActor().id }], notificationsQueued: false,
    acknowledged: false, acknowledgedBy: null, acknowledgedAt: null, resolvedAt: null, createdAt: now,
    hasVideoClip: false, videoClipId: null, videoClip: null,
    ...(typeof input.audioTranscript === "string" ? { audioTranscript: input.audioTranscript.slice(0, 5000) } : {}) };
  const saved = await createSafetyEvent(event);
  if (sessionId && isMongoEnabled()) await (await getDb()).collection("monitoring_sessions").updateOne({ id: sessionId, residentId }, { $max: { lastObservedEventAt: saved.createdAt }, $set: { state: saved.severity } });
  return saved;
}
