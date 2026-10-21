import { MongoClient, type Db } from "mongodb";

const DB_NAME = process.env.MONGODB_DB || "elderwatch_ai";
const mongoGlobal = globalThis as typeof globalThis & { sensaraMongo?: Promise<MongoClient> };

export function isMongoEnabled(): boolean {
  return Boolean(process.env.MONGODB_URI);
}

export async function getMongoClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (!mongoGlobal.sensaraMongo) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    mongoGlobal.sensaraMongo = client.connect().catch(async error => {
      mongoGlobal.sensaraMongo = undefined;
      await client.close();
      throw error;
    });
  }
  return mongoGlobal.sensaraMongo;
}

export async function getDb(): Promise<Db> {
  return (await getMongoClient()).db(DB_NAME);
}
