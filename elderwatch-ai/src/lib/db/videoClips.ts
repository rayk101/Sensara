import { assertPatient } from "../platform/auth";
import { ObjectId } from "mongodb";
import { getDb, isMongoEnabled } from "../mongodb";
import { getInMemoryStore } from "../mockData";
import type { VideoClip } from "../types";

const COLLECTION = "video_clips";

export async function createVideoClip(clip: Omit<VideoClip, "_id">): Promise<VideoClip> {
  assertPatient(clip.residentId);
  if (!isMongoEnabled()) {
    const prior = getInMemoryStore().getVideoClipsByResident(clip.residentId).find(c => c.s3Key === clip.s3Key);
    if (prior) return prior;
    const stored: VideoClip = { ...clip, _id: new ObjectId().toHexString() };
    return getInMemoryStore().createVideoClip(stored);
  }
  const db = await getDb();
  await db.collection(COLLECTION).updateOne({ s3Key: clip.s3Key }, { $setOnInsert: clip }, { upsert: true });
  const saved = (await db.collection(COLLECTION).findOne({ s3Key: clip.s3Key }))!;
  return { ...saved, _id: saved._id.toString() } as unknown as VideoClip;
}

export async function getVideoClipsByResident(residentId: string, limit = 20): Promise<VideoClip[]> {
  assertPatient(residentId);
  if (!isMongoEnabled()) {
    return getInMemoryStore().getVideoClipsByResident(residentId).slice(0, limit);
  }
  const db = await getDb();
  return db
    .collection<VideoClip>(COLLECTION)
    .find({ residentId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray() as Promise<VideoClip[]>;
}

export async function getVideoClipById(id: string): Promise<VideoClip | null> {
  const clip = !isMongoEnabled() ? getInMemoryStore().getVideoClipById(id) : await (await getDb()).collection(COLLECTION).findOne({ _id: ObjectId.isValid(id) ? new ObjectId(id) : id } as object) as unknown as VideoClip | null;
  if (clip) assertPatient(clip.residentId);
  return clip;
}

export async function seedVideoClips(): Promise<void> {
  if (!isMongoEnabled()) return;
  const db = await getDb();
  const col = db.collection(COLLECTION);
  const existing = await col.countDocuments();
  if (existing > 0) return;
  // Seed is intentionally a no-op for real clips since there's no actual S3 content in demo
}
