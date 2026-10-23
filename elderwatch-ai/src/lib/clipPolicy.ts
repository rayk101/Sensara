import type { SafetyEvent } from "./types";

// The saved incident chooses the policy; upload clients cannot choose a shorter clip.
export function clipPolicy(source: SafetyEvent["source"]) {
  return source === "multi_feed_demo"
    ? { seconds: 7, minSeconds: 5, maxSeconds: 8 }
    : { seconds: 15, minSeconds: 14, maxSeconds: 20 };
}

export function clipFileName(event: SafetyEvent, extension: "mp4" | "webm") {
  const patient = event.residentName.trim().split(/\s+/)[0].normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60) || "patient";
  const label = event.source === "multi_feed_demo" ? patient : "live-feed-demo";
  const timestamp = new Date(event.firstUrgentAt ?? event.createdAt).toISOString().replace(/[:.]/g, "-");
  return `${label}-${timestamp}.${extension}`;
}
