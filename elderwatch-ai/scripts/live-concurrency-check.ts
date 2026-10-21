import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb, getMongoClient } from "../src/lib/mongodb";
import { submitIncident } from "../src/lib/platform/incidents";
import { saveResident } from "../src/lib/db/residents";
import { updateSettings } from "../src/lib/platform/settings";
import { MOCK_RESIDENTS } from "../src/lib/mockData";
import { transitionIncident } from "../src/lib/db/events";
const run = promisify(execFile);
if (process.env.SENSARA_LIVE_TESTS !== "1" || !process.env.MONGODB_DB?.startsWith("sensara_verification_")) throw new Error("Isolated test database and opt-in required");
async function main() {
  if (process.argv.includes("--worker")) { const input = JSON.parse(await readFile(process.argv.at(-1)!, "utf8")); console.log((await submitIncident(input))._id); return; }
  await updateSettings({ voiceEnabled: false, notificationsEnabled: false, recordingEnabled: false });
  const id = `concurrency_${randomUUID()}`;
  await saveResident({ ...MOCK_RESIDENTS[0], id, name: "Fictional Concurrency Test" });
  const file = "/private/tmp/sensara-concurrency-input.json";
  await writeFile(file, JSON.stringify({ residentId: id, source: "manual", sourceEventId: randomUUID(), severity: "urgent", eventType: "possible_fall", confidence: .9, reason: "Fictional concurrent process test", detectedAt: new Date().toISOString() }), { mode: 0o600 });
  const outputs = await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ["--env-file=.env.local", "--import", "tsx", "scripts/live-concurrency-check.ts", "--worker", file], { timeout: 30000 })));
  const ids = outputs.map(o => o.stdout.trim()); assert.equal(new Set(ids).size, 1);
  assert.equal(await (await getDb()).collection("safety_events").countDocuments({ residentId: id }), 1);
  await transitionIncident(ids[0], "dismissed", "Verification", "Fictional cross-process concurrency test complete");
  console.log("PASS: four independent Node processes concurrently ingest one event; Atlas stores one incident and one initial workflow");
}
main().catch(() => { console.error("Cross-process concurrency test failed"); process.exitCode = 1; }).finally(async () => { await (await getMongoClient()).close(); });
