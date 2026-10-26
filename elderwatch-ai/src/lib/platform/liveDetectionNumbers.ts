import { ObjectId } from "mongodb";
import { recordingSource } from "../clipPolicy";
import { getSafetyEvent } from "../db/events";
import { getDb, getMongoClient, isMongoEnabled } from "../mongodb";
import type { SafetyEvent } from "../types";
import { ApiError } from "./auth";
import { memory } from "./store";

const counterId = "live-camera";
const validNumber = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

// Read-only migration planning. These numbers are estimates until --apply
// reserves them; a concurrent camera upload can advance the actual counter.
export async function previewLiveDetectionNumbers(events: SafetyEvent[]): Promise<SafetyEvent[]> {
  const counter = !isMongoEnabled()
    ? memory("recording_counters").get(counterId)
    : await (await getDb()).collection<{ _id: string; value: number }>("recording_counters").findOne({ _id: counterId });
  let next = Math.max(Number(counter?.value ?? 0), ...events.map(event => validNumber(event.liveDetectionNumber) ? event.liveDetectionNumber : 0));
  const eventTime = (event: SafetyEvent) => event.criticalDetectedAt ?? event.firstUrgentAt ?? event.createdAt;
  return [...events].sort((a, b) => eventTime(a).localeCompare(eventTime(b)) || String(a._id).localeCompare(String(b._id)))
    .map(event => {
      if (recordingSource(event) !== "live_camera" || validNumber(event.liveDetectionNumber)) return { ...event };
      if (!validNumber(++next)) throw new ApiError(409, "Live detection counter is exhausted");
      return { ...event, liveDetectionNumber: next };
    });
}

// One number per persisted incident. Reserving it with the incident update in
// one transaction makes concurrent prepares and retries reuse the same number.
export async function assignLiveDetectionNumber(event: SafetyEvent): Promise<SafetyEvent> {
  if (recordingSource(event) !== "live_camera") return event;
  if (!event._id) throw new ApiError(400, "A saved incident is required");
  const saved = await getSafetyEvent(event._id);
  if (!saved || recordingSource(saved) !== "live_camera") throw new ApiError(404, "Live camera incident not found");
  if (validNumber(saved.liveDetectionNumber)) return saved;
  if (!isMongoEnabled()) {
    const counters = memory("recording_counters");
    const value = Number(counters.get(counterId)?.value ?? 0) + 1;
    if (!validNumber(value)) throw new ApiError(409, "Live detection counter is exhausted");
    counters.set(counterId, { id: counterId, value });
    saved.liveDetectionNumber = value;
    return saved;
  }
  const db = await getDb();
  const counters = db.collection<{ _id: string; value: number }>("recording_counters");
  // Initialize outside the transaction so the first two simultaneous requests
  // cannot race to insert the singleton while also updating their incidents.
  try { await counters.updateOne({ _id: counterId }, { $setOnInsert: { value: 0 } }, { upsert: true }); }
  catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  const session = (await getMongoClient()).startSession();
  try {
    return (await session.withTransaction(async () => {
      const events = db.collection("safety_events");
      const filter = { _id: ObjectId.isValid(event._id!) ? new ObjectId(event._id) : event._id } as object;
      const current = await events.findOne(filter, { session });
      if (!current) throw new ApiError(404, "Incident not found");
      if (validNumber(current.liveDetectionNumber)) return { ...current, _id: String(current._id) } as unknown as SafetyEvent;
      const counter = await counters.findOneAndUpdate({ _id: counterId }, { $inc: { value: 1 } }, { session, returnDocument: "after" });
      if (!validNumber(counter?.value)) throw new ApiError(409, "Live detection counter is exhausted");
      await events.updateOne(filter, { $set: { liveDetectionNumber: counter.value } }, { session });
      return { ...current, _id: String(current._id), liveDetectionNumber: counter.value } as unknown as SafetyEvent;
    }))!;
  } finally { await session.endSession(); }
}
