import type { SafetyClassification, SafetyEvent } from "./types";

export interface MonitoringActivity extends SafetyClassification {
  id: string;
  source: "camera" | "audio";
  residentId: string;
  residentName: string;
  room: string;
  observedAt: string;
  event?: SafetyEvent;
  persistence: "pending" | "saved" | "failed" | "not_required";
}

export type ActivityUpdate =
  | { type: "observed"; activity: MonitoringActivity }
  | { type: "saved"; id: string; event: SafetyEvent | null }
  | { type: "failed"; id: string }
  | { type: "inactive"; source: MonitoringActivity["source"] };

export interface ActivityFeed {
  entries: MonitoringActivity[];
  current: Partial<Record<MonitoringActivity["source"], string | null>>;
}

export function updateActivityFeed(state: ActivityFeed, update: ActivityUpdate): ActivityFeed {
  if (update.type === "inactive") {
    return state.current[update.source] ? { ...state, current: { ...state.current, [update.source]: null } } : state;
  }
  if (update.type === "observed") return {
    entries: state.entries.some(entry => entry.id === update.activity.id) ? state.entries : [update.activity, ...state.entries].slice(0, 100),
    current: { ...state.current, [update.activity.source]: update.activity.id },
  };
  return { ...state, entries: state.entries.map(entry => entry.id !== update.id ? entry : {
    ...entry,
    ...(update.type === "saved" && update.event ? { event: update.event } : {}),
    persistence: update.type === "failed" ? "failed" : update.event ? "saved" : entry.severity === "stable" ? "not_required" : entry.persistence,
  }) };
}

export function messageProgress(event: SafetyEvent | undefined, notifications: Array<{ channel: string; status: string }>, persistence: MonitoringActivity["persistence"]): string[] {
  const channels: Record<string, string> = { sms: "SMS", imessage: "iMessage", photon: "iMessage", email: "Email" };
  const states: Record<string, string> = {
    queued: "queued", submitted: "sending", accepted: "accepted by provider; delivery unconfirmed",
    delivered: "delivered", failed: "failed", unknown: "delivery unconfirmed", cancelled: "cancelled",
  };
  const messages = notifications.filter(notice => channels[notice.channel]);
  if (messages.length) return [...new Set(messages.map(notice => `${channels[notice.channel]}: ${states[notice.status] ?? "status unavailable"}.`))];
  if (persistence === "failed" && !event) return ["Incident could not be saved. Message delivery is unconfirmed."];
  if (!event) return ["Awaiting incident confirmation. Message delivery is not yet confirmed."];
  const status = event.workflow?.messaging.status;
  if (status === "disabled" || status === "not_requested") return ["Message alerts are off."];
  if (status === "configuration_failed") return ["No alert recipient is configured."];
  if (status === "queued") return ["Caregiver message queued; delivery is not yet confirmed."];
  return ["Message delivery status is unavailable."];
}
