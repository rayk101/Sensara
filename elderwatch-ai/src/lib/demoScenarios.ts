import type { SafetyClassification } from "./types";
export function getScriptedStatus(feedId: string, currentTime: number): SafetyClassification {
  switch (feedId) {
    case "feed1": // fall-demo.mp4
      if (currentTime < 5) return { severity: "stable", eventType: "normal", reason: "No concerning activity detected", confidence: 0.95 };
      if (currentTime < 10) return { severity: "watch", eventType: "unsafe_posture", reason: "Resident posture is worth monitoring", confidence: 0.72 };
      return { severity: "urgent", eventType: "possible_fall", reason: "Resident appears to be lying down with minimal movement — caregiver should check", confidence: 0.90 };
    case "feed2": // stable-demo.mp4
      return { severity: "stable", eventType: "normal", reason: "No concerning activity detected", confidence: 0.95 };
    case "feed3": // wandering-demo.mp4
      if (currentTime < 13) return { severity: "stable", eventType: "normal", reason: "No concerning activity detected", confidence: 0.95 };
      return { severity: "watch", eventType: "wandering", reason: "Resident's torso center has been outside the designated safe area", confidence: 0.78 };
    case "feed4": // choking-demo.mp4
      if (currentTime < 4) return { severity: "stable", eventType: "normal", reason: "No concerning activity detected", confidence: 0.95 };
      return { severity: "urgent", eventType: "possible_choking", reason: "Possible choking gesture detected — caregiver should check immediately", confidence: 0.82 };
    default:
      return { severity: "stable", eventType: "normal", reason: "No concerning activity detected", confidence: 0.95 };
  }
}


export const DEMO_SCENARIOS = [
  { id: "feed1", residentId: "resident_001", videoFile: "fall-demo.mp4", risk: "High fall risk" },
  { id: "feed2", residentId: "resident_002", videoFile: "stable-demo.mp4", risk: "Post-surgery mobility" },
  { id: "feed3", residentId: "resident_003", videoFile: "wandering-demo.mp4", risk: "Wandering / Memory care" },
  { id: "feed4", residentId: "demo_resident_004", videoFile: "choking-demo.mp4", risk: "Medium risk" },
] as const;
