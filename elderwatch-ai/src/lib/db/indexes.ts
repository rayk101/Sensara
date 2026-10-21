import { getDb } from "../mongodb";

// Creates indexes on all collections. Safe to call multiple times — MongoDB
// ignores createIndex calls if an identical index already exists.
export async function ensureIndexes(): Promise<void> {
  const db = await getDb();

  await Promise.all([
    db.collection("event_ingestions").createIndex({ id: 1 }, { unique: true }),
    db.collection("monitoring_observations").createIndex({ id: 1 }, { unique: true }),
    db.collection("safety_events").createIndex({ activeEpisodeKey: 1 }, { unique: true, partialFilterExpression: { activeEpisodeKey: { $type: "string" } } }),
    db.collection("safety_events").createIndex({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }),
    db.collection("safety_events").createIndex({ notificationsQueued: 1, createdAt: 1 }),
    db.collection("safety_events").createIndex({ status: 1, residentId: 1 }),
    db.collection("monitoring_sessions").createIndex({ id: 1 }, { unique: true }),
    db.collection("monitoring_sessions").createIndex({ residentId: 1, startedAt: -1 }),
    db.collection("monitoring_sessions").createIndex({ status: 1, lastSeenAt: 1 }),
    db.collection("notifications").createIndex({ id: 1 }, { unique: true }),
    db.collection("notifications").createIndex({ status: 1, nextAttemptAt: 1 }),
    db.collection("notifications").createIndex({ eventId: 1, residentId: 1 }),
    db.collection("staff").createIndex({ id: 1 }, { unique: true }),
    db.collection("application_settings").createIndex({ id: 1 }, { unique: true }),
    db.collection("upload_intents").createIndex({ id: 1 }, { unique: true }),
    db.collection("upload_intents").createIndex({ eventId: 1 }, { unique: true }),
    // safety_events: sorted lookups by resident and by severity
    db.collection("safety_events").createIndex({ residentId: 1, createdAt: -1 }),
    db.collection("safety_events").createIndex({ severity: 1, createdAt: -1 }),
    db.collection("safety_events").createIndex({ createdAt: -1 }),

    db.collection("video_clips").createIndex({ s3Key: 1 }, { unique: true }),
    // video_clips: per-resident clip list, and lookup by linked event
    db.collection("video_clips").createIndex({ residentId: 1, createdAt: -1 }),
    db.collection("video_clips").createIndex({ eventId: 1 }),

    // caregiver_notes: per-event and per-resident lookups
    db.collection("caregiver_notes").createIndex({ eventId: 1 }),
    db.collection("caregiver_notes").createIndex({ residentId: 1 }),

    // residents: unique lookup by string id field (not _id)
    db.collection("residents").createIndex({ id: 1 }, { unique: true }),
  ]);
}
