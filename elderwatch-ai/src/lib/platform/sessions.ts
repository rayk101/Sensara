import { randomUUID } from "node:crypto";
import { getDb, isMongoEnabled } from "../mongodb";
import { getResidentById } from "../db/residents";
import { ApiError, assertPatient, currentActor } from "./auth";
import { identifier, text } from "./validation";
import { memory, readRecord } from "./store";
export interface MonitoringSession {
  id: string; residentId: string; source: "live_camera" | "multi_feed_demo";
  deviceId: string; startedAt: string; endedAt: string | null; lastSeenAt: string;
  lastObservedEventAt: string | null; status: "active" | "paused" | "ended" | "interrupted";
  state: string; staffId: string; consentAt: string;
}
export async function startSession(input: { residentId: string; source: string; deviceId: string; consent: boolean; id?: string }) {
  const residentId = identifier(input.residentId, "patient");
  assertPatient(residentId);
  const patient = await getResidentById(residentId);
  if (!patient || patient.active === false) throw new ApiError(404, "Active patient not found");
  if (!input.consent) throw new ApiError(400, "Monitoring consent is required");
  if (!["live_camera", "multi_feed_demo"].includes(input.source)) throw new ApiError(400, "Invalid monitoring source");
  const now = new Date().toISOString();
  const value: MonitoringSession = { id: input.id ? identifier(input.id) : randomUUID(), residentId,
    source: input.source as MonitoringSession["source"], deviceId: text(input.deviceId, "camera"),
    startedAt: now, endedAt: null, lastSeenAt: now, lastObservedEventAt: null, status: "active", state: "stable",
    staffId: currentActor().id, consentAt: now };
  if (!isMongoEnabled()) {
    const prior = memory("monitoring_sessions").get(value.id) as MonitoringSession | undefined;
    if (prior && (prior.residentId !== residentId || prior.staffId !== value.staffId)) throw new ApiError(409, "Session identity conflict");
    memory("monitoring_sessions").set(value.id, prior ?? value); return prior ?? value;
  }
  const col = (await getDb()).collection<MonitoringSession>("monitoring_sessions");
  await col.updateOne({ id: value.id }, { $setOnInsert: value }, { upsert: true });
  const saved = (await col.findOne({ id: value.id }))!;
  if (saved.residentId !== residentId || saved.staffId !== value.staffId) throw new ApiError(409, "Session identity conflict");
  return saved;
}
export async function getSession(id: string) {
  const value = await readRecord<MonitoringSession>("monitoring_sessions", identifier(id));
  if (value) assertPatient(value.residentId);
  return value;
}
export async function updateSession(id: string, status: MonitoringSession["status"], state?: string) {
  const session = await getSession(id);
  if (!session) throw new ApiError(404, "Session not found");
  if (session.staffId !== currentActor().id && currentActor().role !== "admin") throw new ApiError(403, "Session belongs to another staff member");
  if (!["active", "paused", "ended", "interrupted"].includes(status)) throw new ApiError(400, "Invalid session status");
  if (["ended", "interrupted"].includes(session.status)) return session;
  const update = { status, lastSeenAt: new Date().toISOString(), state: state ? text(state, "state", 50) : session.state,
    endedAt: ["ended", "interrupted"].includes(status) ? new Date().toISOString() : null };
  if (!isMongoEnabled()) { Object.assign(session, update); return session; }
  return (await getDb()).collection<MonitoringSession>("monitoring_sessions").findOneAndUpdate(
    { id, status: { $in: ["active", "paused"] } }, { $set: update }, { returnDocument: "after" });
}
export async function expireSessions() {
  const cutoff = new Date(Date.now() - 90_000).toISOString();
  if (!isMongoEnabled()) {
    for (const value of memory("monitoring_sessions").values()) if (value.status === "active" && value.lastSeenAt < cutoff) Object.assign(value, { status: "interrupted", endedAt: value.lastSeenAt });
    return;
  }
  await (await getDb()).collection("monitoring_sessions").updateMany({ status: "active", lastSeenAt: { $lt: cutoff } }, [{ $set: { status: "interrupted", endedAt: "$lastSeenAt" } }]);
}
