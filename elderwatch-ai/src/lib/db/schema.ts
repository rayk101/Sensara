import { getDb } from "../mongodb";
import { ensureIndexes } from "./indexes";
const definitions: Record<string, { required: string[]; properties: Record<string, object> }> = {
  residents: { required: ["id", "name", "room"], properties: { id: { bsonType: "string" }, name: { bsonType: "string" }, room: { bsonType: "string" }, active: { bsonType: "bool" } } },
  safety_events: { required: ["residentId", "residentName", "room", "eventType", "severity", "createdAt"], properties: { residentId: { bsonType: "string" }, severity: { enum: ["stable", "watch", "assist", "urgent"] }, status: { enum: ["open", "acknowledged", "resolved", "dismissed"] }, confidence: { bsonType: ["int", "double", "long"], minimum: 0, maximum: 1 } } },
  monitoring_sessions: { required: ["id", "residentId", "source", "startedAt", "status", "staffId", "consentAt"], properties: { id: { bsonType: "string" }, residentId: { bsonType: "string" }, status: { enum: ["active", "paused", "ended", "interrupted"] } } },
  notifications: { required: ["id", "eventId", "residentId", "staffId", "channel", "provider", "status", "createdAt"], properties: { id: { bsonType: "string" }, eventId: { bsonType: "string" }, residentId: { bsonType: "string" }, status: { bsonType: "string" } } },
  video_clips: { required: ["residentId", "s3Key", "bucket", "contentType", "createdAt"], properties: { s3Key: { bsonType: "string" }, fileSize: { bsonType: ["int", "long", "double"], minimum: 1, maximum: 52428800 }, durationSeconds: { bsonType: ["int", "long", "double"], minimum: 0 } } },
  application_settings: { required: ["id", "recordingEnabled", "voiceEnabled", "notificationsEnabled", "retentionDays"], properties: { id: { enum: ["default"] }, retentionDays: { bsonType: ["int", "double"], minimum: 1, maximum: 365 } } },
  staff: { required: ["id", "name", "active", "patientIds", "channel", "destination"], properties: { id: { bsonType: "string" }, patientIds: { bsonType: "array", items: { bsonType: "string" } }, channel: { enum: ["imessage", "sms", "email"] } } },
};
export async function migrateSchema() {
  const db = await getDb();
  const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  for (const [name, definition] of Object.entries(definitions)) {
    const validator = { $jsonSchema: { bsonType: "object", ...definition } };
    if (names.has(name)) await db.command({ collMod: name, validator, validationLevel: "moderate", validationAction: "error" });
    else await db.createCollection(name, { validator, validationLevel: "moderate", validationAction: "error" });
  }
  await ensureIndexes();
}
