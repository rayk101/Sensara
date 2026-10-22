import { MongoClient, type Db } from "mongodb";
import { setServers } from "node:dns";

const DB_NAME = process.env.MONGODB_DB || "elderwatch_ai";
const mongoGlobal = globalThis as typeof globalThis & { sensaraMongo?: Promise<MongoClient>; sensaraMongoDns?: string };

export function isMongoEnabled(): boolean {
  return Boolean(process.env.MONGODB_URI);
}

export async function getMongoClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (!mongoGlobal.sensaraMongo) {
    // Optional process-local workaround for networks that fail Atlas SRV lookups.
    // Configure before connecting; never change the machine's DNS settings.
    const dnsServers = process.env.MONGODB_DNS_SERVERS?.trim();
    if (dnsServers && mongoGlobal.sensaraMongoDns !== dnsServers) {
      setServers(dnsServers.split(",").map(server => server.trim()).filter(Boolean));
      mongoGlobal.sensaraMongoDns = dnsServers;
    }
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 5000 });
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
