import { assertPatient, patientScope, requireAdmin, ApiError } from "../platform/auth";
import { identifier, text } from "../platform/validation";
import { getDb, isMongoEnabled } from "../mongodb";
import { MOCK_RESIDENTS, getInMemoryStore } from "../mockData";
import type { ResidentProfile } from "../types";

const COLLECTION = "residents";

export async function getResidents(): Promise<ResidentProfile[]> {
  if (!isMongoEnabled()) {
    return getInMemoryStore().getResidents().filter(r => { try { assertPatient(r.id); return true; } catch { return false; } });
  }
  const db = await getDb();
  return db.collection<ResidentProfile>(COLLECTION).find(patientScope("id")).toArray() as Promise<ResidentProfile[]>;
}

export async function getResidentById(id: string): Promise<ResidentProfile | null> {
  assertPatient(id);
  if (!isMongoEnabled()) {
    return getInMemoryStore().getResidentById(id);
  }
  const db = await getDb();
  return db.collection<ResidentProfile>(COLLECTION).findOne({ id }) as Promise<ResidentProfile | null>;
}

export async function seedResidents(): Promise<void> {
  if (!isMongoEnabled()) return; // In-memory already has data

  const db = await getDb();
  const col = db.collection<ResidentProfile>(COLLECTION);

  // Upsert each mock resident by their string id field
  for (const resident of MOCK_RESIDENTS) {
    await col.updateOne(
      { id: resident.id },
      { $setOnInsert: resident },
      { upsert: true }
    );
  }
}

export async function saveResident(input: Partial<ResidentProfile>, existingId?: string): Promise<ResidentProfile> {
  requireAdmin();
  const id = identifier(existingId ?? input.id, "patient ID");
  const existing = await getResidentById(id);
  if (existingId && !existing) throw new ApiError(404, "Patient not found");
  if (!existingId && existing) throw new ApiError(409, "Patient ID already exists");
  const merged = { ...existing, ...input };
  const age = merged.age;
  if (typeof age !== "number" || !Number.isInteger(age) || age < 0 || age > 130) throw new ApiError(400, "Invalid age");
  if (!["Low", "Medium", "High"].includes(merged.fallRisk ?? "")) throw new ApiError(400, "Invalid fall risk");
  const strings = (value: unknown) => { if (!Array.isArray(value) || value.length > 30 || value.some(v => typeof v !== "string" || v.length > 200)) throw new ApiError(400, "Invalid patient list"); return value as string[]; };
  if (merged.active !== undefined && typeof merged.active !== "boolean") throw new ApiError(400, "Invalid active status");
  const now = new Date().toISOString();
  const patient: ResidentProfile = { id, name: text(merged.name, "name"), room: text(merged.room, "room"), age,
    mobility: text(merged.mobility ?? "Unspecified", "mobility"), fallRisk: merged.fallRisk!,
    conditions: strings(merged.conditions ?? []), careNotes: typeof merged.careNotes === "string" ? merged.careNotes.slice(0, 2000) : "",
    assignedStaffIds: strings(merged.assignedStaffIds ?? []), supportedUseCases: strings(merged.supportedUseCases ?? []),
    active: merged.active ?? true, monitoringStatus: "idle", monitoringConfig: { recordingEnabled: merged.monitoringConfig?.recordingEnabled === true, audioEnabled: merged.monitoringConfig?.audioEnabled === true },
    createdAt: existing?.createdAt ?? now, updatedAt: now };
  if (!isMongoEnabled()) {
    const records = getInMemoryStore().getResidents();
    const index = records.findIndex(r => r.id === id);
    if (index < 0) records.push(patient); else records[index] = patient;
  } else {
    const col = (await getDb()).collection<ResidentProfile>(COLLECTION);
    if (existingId) await col.updateOne({ id }, { $set: patient }); else await col.insertOne(patient);
  }
  return patient;
}
