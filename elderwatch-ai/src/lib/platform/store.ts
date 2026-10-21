import { getDb, isMongoEnabled } from "../mongodb";
import type { Document, Filter } from "mongodb";
// Explicit in-memory alternative only when MongoDB is absent. Never falls back on DB failure.
const state = globalThis as typeof globalThis & { sensaraPlatform?: Map<string, Map<string, Document>> };
export function memory(name: string) {
  state.sensaraPlatform ??= new Map();
  if (!state.sensaraPlatform.has(name)) state.sensaraPlatform.set(name, new Map());
  return state.sensaraPlatform.get(name)!;
}
export async function readRecord<T extends Document>(name: string, id: string): Promise<T | null> {
  if (!isMongoEnabled()) return (memory(name).get(id) as T) ?? null;
  return (await getDb()).collection<T>(name).findOne({ id } as unknown as Filter<T>) as Promise<T | null>;
}
export async function writeRecord<T extends Document & { id: string }>(name: string, value: T): Promise<T> {
  if (!isMongoEnabled()) { memory(name).set(value.id, value); return value; }
  await (await getDb()).collection(name).updateOne({ id: value.id }, { $set: value }, { upsert: true });
  return value;
}
export async function listRecords<T extends Document>(name: string): Promise<T[]> {
  if (!isMongoEnabled()) return [...memory(name).values()] as T[];
  return (await getDb()).collection<T>(name).find({}).limit(1000).toArray() as Promise<T[]>;
}
