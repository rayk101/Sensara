import { ObjectId } from "mongodb";
import { getDb, isMongoEnabled } from "../mongodb";
import { MOCK_NOTES, getInMemoryStore } from "../mockData";
import type { CaregiverNote } from "../types";

const COLLECTION = "caregiver_notes";

export async function createCaregiverNote(
  note: Omit<CaregiverNote, "_id">
): Promise<CaregiverNote> {
  if (!isMongoEnabled()) {
    const stored: CaregiverNote = { ...note, _id: new ObjectId().toHexString() };
    return getInMemoryStore().createNote(stored);
  }
  const db = await getDb();
  const result = await db.collection(COLLECTION).insertOne(note);
  return { ...note, _id: result.insertedId.toHexString() };
}

export async function getNotesForEvent(eventId: string): Promise<CaregiverNote[]> {
  if (!isMongoEnabled()) {
    return getInMemoryStore().getNotesForEvent(eventId);
  }
  const db = await getDb();
  return db
    .collection<CaregiverNote>(COLLECTION)
    .find({ eventId })
    .sort({ createdAt: -1 })
    .toArray() as Promise<CaregiverNote[]>;
}

export async function seedNotes(): Promise<void> {
  if (!isMongoEnabled()) return;
  const db = await getDb();
  const col = db.collection(COLLECTION);
  const existing = await col.countDocuments();
  if (existing > 0) return;
  await db.collection<CaregiverNote>(COLLECTION).insertMany(MOCK_NOTES);
}
