import type { SafetyEvent } from "./types";

// The saved incident chooses the policy; upload clients cannot choose a shorter clip.
export function clipPolicy(source: SafetyEvent["source"]) {
  return source === "multi_feed_demo"
    ? { seconds: 7, minSeconds: 5, maxSeconds: 8 }
    : { seconds: 15, minSeconds: 14, maxSeconds: 20 };
}

export function clipFileName(event: SafetyEvent, extension: "mp4" | "webm") {
  const timestamp = new Date(event.firstUrgentAt ?? event.createdAt).toISOString().replace(/[:.]/g, "-");
  return `${patientFolderName(event.residentName)}-${timestamp}.${extension}`;
}

export function patientFolderName(name: string) {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "patient";
}

export function clipObjectKey(event: SafetyEvent, extension: "mp4" | "webm") {
  if (!event._id || !/^[a-zA-Z0-9_-]+$/.test(String(event._id)) || !/^[a-zA-Z0-9_-]+$/.test(event.residentId)) throw new Error("Invalid recording identity");
  const source = event.source === "multi_feed_demo" ? "demo" : "live-camera";
  // Keep the stable patient ID as well as the readable name, so namesakes cannot collide.
  return `critical-events/${source}/residents/${patientFolderName(event.residentName)}--${event.residentId}/${event._id}/${clipFileName(event, extension)}`;
}
