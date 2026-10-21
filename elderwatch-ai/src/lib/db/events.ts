import { assertPatient, patientScope, currentActor, ApiError } from "../platform/auth";
import { ObjectId } from "mongodb";
import { getDb, isMongoEnabled } from "../mongodb";
import { generateMockEvents, getInMemoryStore } from "../mockData";
import { getVideoClipsByResident } from "./videoClips";
import type { SafetyEvent, DashboardAnalytics, ResidentHistory, EventTypeValue, VideoClipMeta } from "../types";

const COLLECTION = "safety_events";

export async function createSafetyEvent(event: Omit<SafetyEvent, "_id">): Promise<SafetyEvent> {
  assertPatient(event.residentId);
  if (!isMongoEnabled()) {
    const existing = event.idempotencyKey && getInMemoryStore().getRecentEvents(100000).find(e => e.idempotencyKey === event.idempotencyKey);
    if (existing) return existing;
    const stored: SafetyEvent = { ...event, _id: new ObjectId().toHexString() };
    return getInMemoryStore().createEvent(stored);
  }
  const db = await getDb();
  if (event.idempotencyKey) {
    const col = db.collection(COLLECTION);
    await col.updateOne({ idempotencyKey: event.idempotencyKey }, { $setOnInsert: event }, { upsert: true });
    const saved = await col.findOne({ idempotencyKey: event.idempotencyKey });
    return { ...saved, _id: saved!._id.toString() } as unknown as SafetyEvent;
  }
  const result = await db.collection(COLLECTION).insertOne(event);
  return { ...event, _id: result.insertedId.toHexString() };
}

export async function getRecentEvents(limit = 50): Promise<SafetyEvent[]> {
  if (!isMongoEnabled()) {
    return getInMemoryStore().getRecentEvents(100000).filter(e => { try { assertPatient(e.residentId); return true; } catch { return false; } }).slice(0, limit);
  }
  const db = await getDb();
  return db
    .collection<SafetyEvent>(COLLECTION)
    .find(patientScope())
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray() as Promise<SafetyEvent[]>;
}

export async function getEventsByResident(
  residentId: string,
  limit = 30
): Promise<SafetyEvent[]> {
  assertPatient(residentId);
  if (!isMongoEnabled()) {
    return getInMemoryStore().getEventsByResident(residentId, limit);
  }
  const db = await getDb();
  return db
    .collection<SafetyEvent>(COLLECTION)
    .find({ residentId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray() as Promise<SafetyEvent[]>;
}

export async function acknowledgeEvent(id: string, acknowledgedBy: string): Promise<SafetyEvent | null> {
  return transitionIncident(id, "acknowledged", acknowledgedBy);
}
export async function transitionIncident(id: string, status: "acknowledged" | "resolved" | "dismissed", by = currentActor().name, reason?: string): Promise<SafetyEvent | null> {
  const event = await getSafetyEvent(id);
  if (!event) return null;
  if (status !== "acknowledged" && (!reason?.trim() || reason.length > 2000)) throw new ApiError(400, "A resolution or dismissal reason is required");
  if (event.status === status || (status === "acknowledged" && event.acknowledged)) return event;
  if (["resolved", "dismissed"].includes(event.status ?? "") || (status === "resolved" && !event.acknowledged)) throw new ApiError(409, "Acknowledge the incident before resolving it; resolved incidents cannot reopen");
  const now = new Date().toISOString();
  const update = status === "acknowledged" ? { status, acknowledged: true, acknowledgedAt: now, acknowledgedBy: by } : { status, resolvedAt: now };
  const entry = { status, at: now, by, ...(reason ? { reason: reason.trim() } : {}) };
  if (!isMongoEnabled()) { Object.assign(event, update); event.version = (event.version ?? 0) + 1; if (status !== "acknowledged") delete event.activeEpisodeKey; (event.stateHistory ??= []).push(entry); return event; }
  const filter = { _id: ObjectId.isValid(id) ? new ObjectId(id) : id, status: event.status ?? { $exists: false }, version: event.version ?? { $exists: false } };
  const result = await (await getDb()).collection<SafetyEvent>(COLLECTION).findOneAndUpdate(filter as object, { $set: update, $inc: { version: 1 }, ...(status !== "acknowledged" ? { $unset: { activeEpisodeKey: "" } } : {}), $push: { stateHistory: entry } }, { returnDocument: "after" });
  return (result ?? await getSafetyEvent(id)) as unknown as SafetyEvent;
}

export async function getEventAnalytics(): Promise<DashboardAnalytics> {
  if (!isMongoEnabled()) {
    const all = (await getRecentEvents(100000)).filter(e => Date.parse(e.createdAt) >= Date.now() - 86400_000);
    const types = new Map<string, number>(), patients = new Map<string, { name: string; room: string; count: number }>();
    for (const e of all) { types.set(e.eventType, (types.get(e.eventType) ?? 0) + 1); const p = patients.get(e.residentId) ?? { name: e.residentName, room: e.room, count: 0 }; p.count++; patients.set(e.residentId, p); }
    return { totalEventsLast24h: all.length, urgentEventsLast24h: all.filter(e => e.severity === "urgent").length, assistEventsLast24h: all.filter(e => e.severity === "assist").length, mostFrequentEventType: ([...types].sort((a,b) => b[1]-a[1])[0]?.[0] as EventTypeValue) ?? null, residentWithMostAlerts: [...patients.values()].sort((a,b) => b.count-a.count)[0] ?? null };
  }
  const db = await getDb();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [total, urgent, assist] = await Promise.all([
    db.collection(COLLECTION).countDocuments({ ...patientScope(), createdAt: { $gte: cutoff } }),
    db.collection(COLLECTION).countDocuments({ ...patientScope(), severity: "urgent", createdAt: { $gte: cutoff } }),
    db.collection(COLLECTION).countDocuments({ ...patientScope(), severity: "assist", createdAt: { $gte: cutoff } }),
  ]);

  const typeAgg = await db
    .collection(COLLECTION)
    .aggregate([
      { $match: { ...patientScope(), createdAt: { $gte: cutoff } } },
      { $group: { _id: "$eventType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ])
    .toArray();

  const residentAgg = await db
    .collection(COLLECTION)
    .aggregate([
      { $match: { ...patientScope(), createdAt: { $gte: cutoff } } },
      {
        $group: {
          _id: "$residentId",
          name: { $first: "$residentName" },
          room: { $first: "$room" },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ])
    .toArray();

  return {
    totalEventsLast24h: total,
    urgentEventsLast24h: urgent,
    assistEventsLast24h: assist,
    mostFrequentEventType: (typeAgg[0]?._id as EventTypeValue) ?? null,
    residentWithMostAlerts: residentAgg[0]
      ? { name: residentAgg[0].name, room: residentAgg[0].room, count: residentAgg[0].count }
      : null,
  };
}

export async function getResidentHistory(residentId: string): Promise<ResidentHistory> {
  assertPatient(residentId);
  if (!isMongoEnabled()) {
    return getInMemoryStore().getResidentHistory(residentId) as ResidentHistory;
  }
  const db = await getDb();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString();

  const [todayEvents, allEvents, videoClips, summary, clipCount] = await Promise.all([
    db
      .collection(COLLECTION)
      .countDocuments({ residentId, createdAt: { $gte: todayStr } }),
    db
      .collection<SafetyEvent>(COLLECTION)
      .find({ residentId })
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray(),
    getVideoClipsByResident(residentId, 10),
    db.collection(COLLECTION).aggregate([
      { $match: { residentId } },
      { $group: { _id: { eventType: "$eventType", severity: "$severity" }, count: { $sum: 1 } } },
    ]).toArray(),
    db.collection("video_clips").countDocuments({ residentId }),
  ]);

  const typeCounts: Record<string, number> = {};
  const severityCounts: Record<string, number> = {};
  for (const item of summary) {
    typeCounts[item._id.eventType] = (typeCounts[item._id.eventType] || 0) + item.count;
    severityCounts[item._id.severity] = (severityCounts[item._id.severity] || 0) + item.count;
  }
  const mostCommon = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];

  return {
    totalEventsToday: todayEvents,
    urgentEvents: severityCounts.urgent ?? 0,
    assistEvents: severityCounts.assist ?? 0,
    watchEvents: severityCounts.watch ?? 0,
    totalVideoClips: clipCount,
    latestVideoClipAt: videoClips[0]?.createdAt ?? null,
    mostCommonEventType: (mostCommon?.[0] as EventTypeValue) ?? null,
    lastEventAt: allEvents[0]?.createdAt ?? null,
    recentEvents: allEvents.slice(0, 20) as SafetyEvent[],
    videoClips,
  };
}

export async function seedEvents(): Promise<void> {
  if (!isMongoEnabled()) return;
  const db = await getDb();
  const col = db.collection(COLLECTION);
  const existing = await col.countDocuments();
  if (existing > 0) return; // Don't re-seed
  const events = generateMockEvents();
  await db.collection<SafetyEvent>(COLLECTION).insertMany(events);
}

export async function getSafetyEvent(id: string): Promise<SafetyEvent | null> {
  let event: SafetyEvent | null;
  if (!isMongoEnabled()) event = getInMemoryStore().getEventById(id);
  else event = await (await getDb()).collection(COLLECTION).findOne({ _id: ObjectId.isValid(id) ? new ObjectId(id) : id } as object) as unknown as SafetyEvent | null;
  if (event) assertPatient(event.residentId);
  return event;
}

export async function linkVideoClipToEvent(
  id: string,
  clipId: string,
  videoClip: VideoClipMeta
): Promise<SafetyEvent | null> {
  if (!await getSafetyEvent(id)) return null;
  const update = { hasVideoClip: true, videoClipId: clipId, videoClip };
  if (!isMongoEnabled()) {
    const event = getInMemoryStore().getEventById(id);
    if (!event) return null;
    Object.assign(event, update);
    return event;
  }
  const db = await getDb();
  const filter = { _id: ObjectId.isValid(id) ? new ObjectId(id) : id };
  return db.collection(COLLECTION).findOneAndUpdate(
    filter as object, { $set: update }, { returnDocument: "after" }
  ) as unknown as Promise<SafetyEvent | null>;
}
