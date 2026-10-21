import { ObjectId } from "mongodb";
import { getDb, isMongoEnabled } from "../mongodb";
import { generateMockEvents, getInMemoryStore } from "../mockData";
import { getVideoClipsByResident } from "./videoClips";
import type { SafetyEvent, DashboardAnalytics, ResidentHistory, EventTypeValue, VideoClipMeta } from "../types";

const COLLECTION = "safety_events";

export async function createSafetyEvent(event: Omit<SafetyEvent, "_id">): Promise<SafetyEvent> {
  if (!isMongoEnabled()) {
    const stored: SafetyEvent = { ...event, _id: new ObjectId().toHexString() };
    return getInMemoryStore().createEvent(stored);
  }
  const db = await getDb();
  const result = await db.collection(COLLECTION).insertOne(event);
  return { ...event, _id: result.insertedId.toHexString() };
}

export async function getRecentEvents(limit = 50): Promise<SafetyEvent[]> {
  if (!isMongoEnabled()) {
    return getInMemoryStore().getRecentEvents(limit);
  }
  const db = await getDb();
  return db
    .collection<SafetyEvent>(COLLECTION)
    .find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray() as Promise<SafetyEvent[]>;
}

export async function getEventsByResident(
  residentId: string,
  limit = 30
): Promise<SafetyEvent[]> {
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

export async function acknowledgeEvent(
  id: string,
  acknowledgedBy: string
): Promise<SafetyEvent | null> {
  if (!isMongoEnabled()) {
    return getInMemoryStore().acknowledgeEvent(id, acknowledgedBy);
  }
  const db = await getDb();
  const now = new Date().toISOString();
  let filter: object;
  try {
    filter = { _id: new ObjectId(id) };
  } catch {
    filter = { _id: id };
  }
  const result = await db.collection<SafetyEvent>(COLLECTION).findOneAndUpdate(
    filter,
    { $set: { acknowledged: true, acknowledgedBy, acknowledgedAt: now } },
    { returnDocument: "after" }
  );
  return result as SafetyEvent | null;
}

export async function getEventAnalytics(): Promise<DashboardAnalytics> {
  if (!isMongoEnabled()) {
    return getInMemoryStore().getAnalytics() as DashboardAnalytics;
  }
  const db = await getDb();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [total, urgent, assist] = await Promise.all([
    db.collection(COLLECTION).countDocuments({ createdAt: { $gte: cutoff } }),
    db.collection(COLLECTION).countDocuments({ severity: "urgent", createdAt: { $gte: cutoff } }),
    db.collection(COLLECTION).countDocuments({ severity: "assist", createdAt: { $gte: cutoff } }),
  ]);

  const typeAgg = await db
    .collection(COLLECTION)
    .aggregate([
      { $match: { createdAt: { $gte: cutoff } } },
      { $group: { _id: "$eventType", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ])
    .toArray();

  const residentAgg = await db
    .collection(COLLECTION)
    .aggregate([
      { $match: { createdAt: { $gte: cutoff } } },
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
  if (!isMongoEnabled()) return getInMemoryStore().getEventById(id);
  const db = await getDb();
  const filter = { _id: ObjectId.isValid(id) ? new ObjectId(id) : id };
  return db.collection(COLLECTION).findOne(filter as object) as unknown as Promise<SafetyEvent | null>;
}

export async function linkVideoClipToEvent(
  id: string,
  clipId: string,
  videoClip: VideoClipMeta
): Promise<SafetyEvent | null> {
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
