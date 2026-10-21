import { getResidents } from "../db/residents";
import { getDb, isMongoEnabled } from "../mongodb";
import { getInMemoryStore } from "../mockData";
import { memory } from "./store";
export async function monitoringState() {
  const patients = await getResidents();
  const db = isMongoEnabled() ? await getDb() : null;
  return Promise.all(patients.map(async patient => {
    const session = db ? await db.collection("monitoring_sessions").findOne({ residentId: patient.id }, { sort: { startedAt: -1 } }) : [...memory("monitoring_sessions").values()].filter(s => s.residentId === patient.id).sort((a,b) => b.startedAt.localeCompare(a.startedAt))[0];
    const observation = db ? await db.collection("monitoring_observations").findOne({ id: patient.id }) : memory("monitoring_observations").get(patient.id);
    const active = db ? await db.collection("safety_events").countDocuments({ residentId: patient.id, severity: "urgent", status: { $in: ["open", "acknowledged"] } }) : getInMemoryStore().getRecentEvents(100000).filter(e => e.residentId === patient.id && e.severity === "urgent" && ["open", "acknowledged"].includes(e.status ?? "open")).length;
    const health = !session ? "STOPPED" : session.status === "paused" ? "PAUSED" : session.status === "ended" ? "STOPPED" : session.status === "interrupted" || Date.parse(session.lastSeenAt) < Date.now() - 90000 ? "OFFLINE" : "ACTIVE";
    const fresh = health === "ACTIVE" && observation?.sessionId === session?.id && Date.parse(observation?.detectedAt) > Date.now() - 15000;
    const observed = fresh ? ({ stable: "NORMAL", watch: "WATCHING", assist: "WATCHING", urgent: "URGENT" }[observation!.severity as string] ?? "UNKNOWN") : "UNKNOWN";
    return { patientId: patient.id, name: patient.name, room: patient.room, priority: active ? "URGENT" : observed, observed, health, activeIncidents: active };
  }));
}
