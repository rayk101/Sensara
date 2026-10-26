import type { SafetyEvent } from "./types";

export function recordingSource(event: SafetyEvent): SafetyEvent["recordingSource"] {
  if (event.source === "live_camera" || event.source === "multi_feed_demo") return event.source;
  if (event.source === "manual" && event.sessionId) return event.recordingSource;
  return undefined;
}

// The saved incident chooses the policy; upload clients cannot choose a shorter clip.
export function clipPolicy(source: SafetyEvent["source"]) {
  return source === "multi_feed_demo"
    ? { seconds: 7, minSeconds: 5, maxSeconds: 8 }
    : { seconds: 15, minSeconds: 14, maxSeconds: 20 };
}

export function clipFileName(event: SafetyEvent, extension: "mp4" | "webm") {
  const live = recordingSource(event) === "live_camera";
  const timestamp = new Date((live ? event.criticalDetectedAt : undefined) ?? event.firstUrgentAt ?? event.createdAt).toISOString().replace(/[:.]/g, "-");
  if (live) {
    if (!Number.isSafeInteger(event.liveDetectionNumber) || event.liveDetectionNumber! < 1) throw new Error("A live detection number is required");
    return `live-detection-${event.liveDetectionNumber}-${timestamp}.${extension}`;
  }
  return `${patientFolderName(event.residentName)}-${timestamp}.${extension}`;
}

export function patientFolderName(name: string) {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "patient";
}

export function clipObjectKey(event: SafetyEvent, extension: "mp4" | "webm") {
  if (!event._id || !/^[a-zA-Z0-9_-]+$/.test(String(event._id)) || !/^[a-zA-Z0-9_-]+$/.test(event.residentId)) throw new Error("Invalid recording identity");
  const source = recordingSource(event);
  if (!source) throw new Error("A camera recording source is required");
  if (source === "live_camera") return `critical-events/live-camera/${clipFileName(event, extension)}`;
  // Keep the stable patient ID as well as the readable name, so namesakes cannot collide.
  return `critical-events/demo/residents/${patientFolderName(event.residentName)}--${event.residentId}/${event._id}/${clipFileName(event, extension)}`;
}
