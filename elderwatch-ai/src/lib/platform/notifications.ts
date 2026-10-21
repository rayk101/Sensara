import { createHash, randomUUID } from "node:crypto";
import { getDb, isMongoEnabled } from "../mongodb";
import { getSafetyEvent } from "../db/events";
import { getResidentById } from "../db/residents";
import { getInMemoryStore } from "../mockData";
import type { SafetyEvent } from "../types";
import { memory } from "./store";
import { getCaregivers, getSettings, type Caregiver } from "./settings";
import { patientScope, assertPatient, ApiError } from "./auth";
import { sendPhotonMessage } from "../photon";
export interface NotificationRecord {
  id: string; eventId: string; residentId: string; staffId: string; channel: Caregiver["channel"];
  provider: string; status: "queued" | "submitted" | "accepted" | "delivered" | "failed" | "unknown" | "cancelled";
  attemptId?: string; attemptCount?: number; attempts?: Array<{ attemptId: string; status: string; at: string }>;
  providerMessageId: string | null; retryCount: number; createdAt: string; lastAttemptAt: string | null;
  nextAttemptAt: string; leaseUntil?: string | null; leaseOwner?: string; error: string | null;
}
export function notificationText(event: SafetyEvent, details: boolean) {
  if (!details) return "Urgent patient safety incident detected. Open the secure Sensara dashboard for details.";
  return `SENSARA DEMO — URGENT PATIENT ALERT\nPatient: ${event.residentName}\nRoom: ${event.room}\nIncident: ${event.eventType.replace(/_/g, " ")}\nTime: ${event.createdAt}\nAction: ${event.recommendedAction}`;
}
export async function enqueueNotifications(event: SafetyEvent) {
  if (!event._id) return;
  const settings = await getSettings();
  const recipients = event.severity === "urgent" && settings.notificationsEnabled ? (await getCaregivers()).filter(r => r.active && r.urgentAlerts && r.patientIds.includes(event.residentId) && (event.workflow?.messaging.recipientIds.includes(r.id) ?? true)) : [];
  for (const r of recipients) {
    const id = createHash("sha256").update(`${event._id}:${r.id}:${r.channel}`).digest("hex");
    const record: NotificationRecord = { id, eventId: String(event._id), residentId: event.residentId, staffId: r.id,
      channel: r.channel, provider: r.channel === "imessage" ? "photon" : r.channel === "sms" ? "twilio" : "resend",
      status: "queued", providerMessageId: null, retryCount: 0, createdAt: new Date().toISOString(), lastAttemptAt: null, nextAttemptAt: new Date().toISOString(), error: null };
    if (!isMongoEnabled()) { if (!memory("notifications").has(id)) memory("notifications").set(id, record); }
    else await (await getDb()).collection("notifications").updateOne({ id }, { $setOnInsert: record }, { upsert: true });
  }
  if (!isMongoEnabled()) { const stored = getInMemoryStore().getEventById(String(event._id)); if (stored) stored.notificationsQueued = true; }
  else await (await getDb()).collection("safety_events").updateOne({ idempotencyKey: event.idempotencyKey }, { $set: { notificationsQueued: true } });
}
export async function listNotifications() {
  if (!isMongoEnabled()) return [...memory("notifications").values()].filter(n => { try { assertPatient(n.residentId); return true; } catch { return false; } }).slice(-100) as NotificationRecord[];
  return (await getDb()).collection<NotificationRecord>("notifications").find(patientScope()).sort({ createdAt: -1 }).limit(100).toArray();
}
export async function retryNotification(id: string) {
  const record = !isMongoEnabled() ? memory("notifications").get(id) : await (await getDb()).collection("notifications").findOne({ id });
  if (!record) throw new ApiError(404, "Notification not found");
  assertPatient(record.residentId);
  if (!["failed", "unknown"].includes(record.status)) throw new ApiError(409, "Only failed or uncertain notifications can be retried");
  const update = { status: "queued", retryCount: 0, nextAttemptAt: new Date().toISOString(), error: null };
  if (!isMongoEnabled()) Object.assign(record, update);
  else await (await getDb()).collection("notifications").updateOne({ id, status: { $in: ["failed", "unknown"] } }, { $set: update });
}
export function retryDelay(attempt: number) { return Math.min(300_000, 5000 * 2 ** Math.max(0, attempt - 1)); }
export function failurePolicy(error: unknown): { retry: boolean; uncertain: boolean; message: string } {
  const e = error as { name?: string; message?: string; status?: number; statusCode?: number; code?: string };
  if (e?.message?.includes("Target not allowed")) return { retry: false, uncertain: false, message: "Photon recipient is not authorized for this project" };
  if (e?.status === 429 || e?.statusCode === 429 || e?.code === "RESOURCE_EXHAUSTED") return { retry: true, uncertain: false, message: "Provider rate limit" };
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || e?.code === "DEADLINE_EXCEEDED") return { retry: false, uncertain: true, message: "Provider outcome unknown after timeout; inspect before retrying" };
  if ([401,403,400,404].includes(e?.status ?? e?.statusCode ?? 0) || e?.name === "AuthenticationError") return { retry: false, uncertain: false, message: "Provider rejected credentials or recipient" };
  return { retry: false, uncertain: false, message: "Provider request failed; review configuration before retrying" };
}
export async function deliverNotification(record: NotificationRecord): Promise<string | null> {
  const recipient = (await getCaregivers()).find(r => r.id === record.staffId && r.active && r.urgentAlerts && r.channel === record.channel && r.patientIds.includes(record.residentId));
  const event = await getSafetyEvent(record.eventId);
  const patient = await getResidentById(record.residentId);
  const settings = await getSettings();
  if (!recipient || !event || !patient || patient.active === false || event.acknowledged || ["resolved", "dismissed"].includes(event.status ?? "") || !settings.notificationsEnabled) throw new ApiError(409, "Notification no longer authorized");
  const body = notificationText(event, settings.dataMode === "demo");
  if (recipient.channel === "imessage") return await sendPhotonMessage(body, recipient.destination);
  if (recipient.channel === "sms") {
    const twilio = (await import("twilio")).default;
    const result = await twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, { timeout: 15_000, autoRetry: false }).messages.create({ to: recipient.destination, from: process.env.TWILIO_PHONE_NUMBER, body });
    return result.sid;
  }
  const { Resend } = await import("resend");
  const response = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: process.env.ALERT_FROM_EMAIL!, to: recipient.destination, subject: "Sensara urgent demo alert", text: body }, { idempotencyKey: record.id });
  if (response.error) throw new Error("Email provider rejected request");
  return response.data?.id ?? null;
}
export async function processNotifications(send = deliverNotification) {
  // Reconcile incidents not yet materialized in the outbox after an interrupted request.
  const pending = !isMongoEnabled() ? getInMemoryStore().getRecentEvents(100000).filter(e => e.notificationsQueued === false) : await (await getDb()).collection("safety_events").find({ notificationsQueued: false }).limit(100).toArray() as unknown as SafetyEvent[];
  for (const event of pending) await enqueueNotifications(event);
  const now = new Date().toISOString();
  const leaseOwner = randomUUID();
  const lease = new Date(Date.now() + 60_000).toISOString();
  if (isMongoEnabled()) await (await getDb()).collection("notifications").updateMany({ status: "submitted", leaseUntil: { $lt: now } }, { $set: { status: "unknown", error: "Worker interrupted after submission; inspect provider before retrying" } });
  let record: NotificationRecord | null = null;
  if (!isMongoEnabled()) {
    record = [...memory("notifications").values()].find(n => n.status === "queued" && n.nextAttemptAt <= now) as NotificationRecord ?? null;
    if (record) Object.assign(record, { status: "submitted", lastAttemptAt: now, leaseUntil: lease, leaseOwner, attemptId: leaseOwner, attemptCount: (record.attemptCount ?? 0) + 1, retryCount: record.retryCount + 1 });
  } else record = await (await getDb()).collection<NotificationRecord>("notifications").findOneAndUpdate(
    { status: "queued", nextAttemptAt: { $lte: now } }, { $set: { status: "submitted", lastAttemptAt: now, leaseUntil: lease, leaseOwner, attemptId: leaseOwner }, $inc: { retryCount: 1, attemptCount: 1 } }, { returnDocument: "after", sort: { createdAt: 1 } });
  if (!record) return;
  let update: Partial<NotificationRecord>;
  try { update = { status: "accepted", providerMessageId: await send(record), error: null, leaseUntil: null }; }
  catch (error) {
    const failure = failurePolicy(error);
    update = { status: error instanceof ApiError && error.status === 409 ? "cancelled" : failure.uncertain ? "unknown" : failure.retry && record.retryCount < 4 ? "queued" : "failed",
      nextAttemptAt: new Date(Date.now() + retryDelay(record.retryCount) + Math.floor(Math.random() * 1000)).toISOString(), error: failure.message, leaseUntil: null };
  }
  const attempt = { attemptId: leaseOwner, status: update.status!, at: new Date().toISOString() };
  if (!isMongoEnabled()) { Object.assign(record, update); (record.attempts ??= []).push(attempt); }
  else await (await getDb()).collection<NotificationRecord>("notifications").updateOne({ id: record.id, status: "submitted", leaseOwner }, { $set: update, $push: { attempts: attempt } });
}
