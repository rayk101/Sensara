// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA ONLY — This file contains entirely fictitious resident profiles
// and safety events. None of this represents real patients or real incidents.
// For demonstration purposes only.
// ─────────────────────────────────────────────────────────────────────────────

import type { ResidentProfile, SafetyEvent, CaregiverNote, VideoClip } from "./types";

export const MOCK_RESIDENTS: ResidentProfile[] = [
  {
    id: "resident_001",
    name: "Eleanor Brooks",
    age: 82,
    room: "Room 204",
    mobility: "Uses walker",
    fallRisk: "High",
    conditions: ["Balance difficulty", "Mild memory impairment"],
    careNotes: "Check if resident leaves bed after 10 PM.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "resident_002",
    name: "Robert Hayes",
    age: 76,
    room: "Room 118",
    mobility: "Independent",
    fallRisk: "Medium",
    conditions: ["Recent hip surgery"],
    careNotes: "Alert caregiver if prolonged immobility is detected.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "resident_003",
    name: "Margaret Chen",
    age: 79,
    room: "Room 312",
    mobility: "Wheelchair",
    fallRisk: "Low",
    conditions: ["Arthritis", "Mild hearing loss"],
    careNotes: "Ensure wheelchair brakes are engaged when seated.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "demo_resident_004", name: "Daniel Price", age: 80, room: "Lounge Area",
    mobility: "Independent", fallRisk: "Medium", conditions: [],
    careNotes: "Check on resident during shared lounge activities.",
  },
];

// Generates a batch of realistic historical events spread over the last 24h
export function generateMockEvents(): SafetyEvent[] {
  const now = Date.now();
  const hour = 60 * 60 * 1000;

  return [
    {
      _id: "event_001",
      residentId: "resident_001",
      residentName: "Eleanor Brooks",
      room: "Room 204",
      severity: "urgent",
      eventType: "possible_fall",
      confidence: 0.91,
      reason: "Resident appears to be lying down with minimal movement",
      recommendedAction:
        "Check if the resident is conscious and responsive. Do not move them if they report pain. Follow facility emergency protocol.",
      signals: {
        isLyingDown: true,
        movementScore: 0.04,
        postureAngle: 73,
        secondsStill: 14,
        insideSafeZone: true,
        visible: true,
      },
      source: "live_camera",
      acknowledged: true,
      acknowledgedBy: "Demo Caregiver",
      acknowledgedAt: new Date(now - 2.5 * hour).toISOString(),
      createdAt: new Date(now - 3 * hour).toISOString(),
    },
    {
      _id: "event_002",
      residentId: "resident_001",
      residentName: "Eleanor Brooks",
      room: "Room 204",
      severity: "watch",
      eventType: "wandering",
      confidence: 0.78,
      reason: "Resident has left the designated safe area",
      recommendedAction:
        "Gently redirect the resident to their safe area. Note the time and location in the care log.",
      signals: {
        isLyingDown: false,
        movementScore: 0.45,
        postureAngle: 12,
        secondsStill: 0,
        insideSafeZone: false,
        visible: true,
      },
      source: "live_camera",
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null,
      createdAt: new Date(now - 5 * hour).toISOString(),
    },
    {
      _id: "event_003",
      residentId: "resident_002",
      residentName: "Robert Hayes",
      room: "Room 118",
      severity: "assist",
      eventType: "immobility",
      confidence: 0.84,
      reason: "Resident has shown very little movement for several minutes",
      recommendedAction:
        "Check on the resident to ensure they are comfortable and responsive. Offer fluids and assess for discomfort.",
      signals: {
        isLyingDown: false,
        movementScore: 0.02,
        postureAngle: 8,
        secondsStill: 340,
        insideSafeZone: true,
        visible: true,
      },
      source: "live_camera",
      acknowledged: true,
      acknowledgedBy: "Demo Caregiver",
      acknowledgedAt: new Date(now - 1 * hour).toISOString(),
      createdAt: new Date(now - 1.5 * hour).toISOString(),
    },
    {
      _id: "event_004",
      residentId: "resident_002",
      residentName: "Robert Hayes",
      room: "Room 118",
      severity: "assist",
      eventType: "unsafe_posture",
      confidence: 0.8,
      reason: "Resident posture appears unstable or heavily slumped",
      recommendedAction:
        "Assist the resident to a more comfortable and stable position. Check for dizziness.",
      signals: {
        isLyingDown: false,
        movementScore: 0.1,
        postureAngle: 68,
        secondsStill: 45,
        insideSafeZone: true,
        visible: true,
      },
      source: "live_camera",
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null,
      createdAt: new Date(now - 8 * hour).toISOString(),
    },
    {
      _id: "event_005",
      residentId: "resident_003",
      residentName: "Margaret Chen",
      room: "Room 312",
      severity: "watch",
      eventType: "out_of_frame",
      confidence: 0.72,
      reason: "Resident is no longer visible in the camera frame",
      recommendedAction:
        "Verify the resident's location manually. They may have moved out of camera view.",
      signals: {
        isLyingDown: false,
        movementScore: 0,
        postureAngle: 0,
        secondsStill: 0,
        insideSafeZone: true,
        visible: false,
      },
      source: "live_camera",
      acknowledged: true,
      acknowledgedBy: "Demo Caregiver",
      acknowledgedAt: new Date(now - 6 * hour).toISOString(),
      createdAt: new Date(now - 6.2 * hour).toISOString(),
    },
    {
      _id: "event_006",
      residentId: "resident_001",
      residentName: "Eleanor Brooks",
      room: "Room 204",
      severity: "watch",
      eventType: "unsafe_posture",
      confidence: 0.65,
      reason: "Resident is leaning — posture worth monitoring",
      recommendedAction:
        "Assist the resident to a more comfortable and stable position. Check for dizziness.",
      signals: {
        isLyingDown: false,
        movementScore: 0.15,
        postureAngle: 38,
        secondsStill: 20,
        insideSafeZone: true,
        visible: true,
      },
      source: "live_camera",
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null,
      createdAt: new Date(now - 10 * hour).toISOString(),
    },
  ];
}

export const MOCK_NOTES: CaregiverNote[] = [
  {
    _id: "note_001",
    residentId: "resident_001",
    eventId: "event_001",
    note: "Caregiver checked on resident. Eleanor had slid off her chair. No injury. Assisted back to bed.",
    createdBy: "Demo Caregiver",
    createdAt: new Date(Date.now() - 2.4 * 60 * 60 * 1000).toISOString(),
  },
  {
    _id: "note_002",
    residentId: "resident_002",
    eventId: "event_003",
    note: "Robert was napping in his chair. Offered water. No concerns.",
    createdBy: "Demo Caregiver",
    createdAt: new Date(Date.now() - 0.9 * 60 * 60 * 1000).toISOString(),
  },
];

// In-memory store used when MongoDB is not connected
export class InMemoryStore {
  private residents: ResidentProfile[] = [...MOCK_RESIDENTS];
  private events: SafetyEvent[] = generateMockEvents();
  private notes: CaregiverNote[] = [...MOCK_NOTES];
  private videoClips: VideoClip[] = [...MOCK_VIDEO_CLIPS];

  getResidents() {
    return this.residents;
  }

  getResidentById(id: string) {
    return this.residents.find((r) => r.id === id) ?? null;
  }

  getRecentEvents(limit = 50) {
    return [...this.events]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  getEventsByResident(residentId: string, limit = 30) {
    return this.events
      .filter((e) => e.residentId === residentId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  getEventById(id: string) {
    return this.events.find((event) => event._id === id) ?? null;
  }

  createEvent(event: SafetyEvent) {
    this.events.unshift(event);
    return event;
  }

  acknowledgeEvent(id: string, by: string) {
    const event = this.events.find((e) => e._id === id);
    if (event) {
      event.acknowledged = true;
      event.acknowledgedBy = by;
      event.acknowledgedAt = new Date().toISOString();
    }
    return event ?? null;
  }

  getNotesForEvent(eventId: string) {
    return this.notes.filter((n) => n.eventId === eventId);
  }

  createNote(note: CaregiverNote) {
    this.notes.unshift(note);
    return note;
  }

  getAnalytics() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = this.events.filter((e) => new Date(e.createdAt).getTime() > cutoff);

    const typeCounts: Record<string, number> = {};
    for (const e of recent) {
      typeCounts[e.eventType] = (typeCounts[e.eventType] || 0) + 1;
    }
    const mostFrequent = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];

    const residentCounts: Record<string, { name: string; room: string; count: number }> = {};
    for (const e of recent) {
      if (!residentCounts[e.residentId]) {
        residentCounts[e.residentId] = { name: e.residentName, room: e.room, count: 0 };
      }
      residentCounts[e.residentId].count++;
    }
    const topResident = Object.values(residentCounts).sort((a, b) => b.count - a.count)[0];

    return {
      totalEventsLast24h: recent.length,
      urgentEventsLast24h: recent.filter((e) => e.severity === "urgent").length,
      assistEventsLast24h: recent.filter((e) => e.severity === "assist").length,
      mostFrequentEventType: mostFrequent ? mostFrequent[0] : null,
      residentWithMostAlerts: topResident ?? null,
    };
  }

  getVideoClipsByResident(residentId: string): VideoClip[] {
    return [...this.videoClips]
      .filter((c) => c.residentId === residentId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  getVideoClipById(id: string): VideoClip | null {
    return this.videoClips.find((c) => c._id === id) ?? null;
  }

  createVideoClip(clip: VideoClip): VideoClip {
    this.videoClips.unshift(clip);
    return clip;
  }

  getResidentHistory(residentId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const events = this.events.filter(event => event.residentId === residentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const todayEvents = events.filter((e) => new Date(e.createdAt) >= today);

    const typeCounts: Record<string, number> = {};
    for (const e of events) {
      typeCounts[e.eventType] = (typeCounts[e.eventType] || 0) + 1;
    }
    const mostCommon = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
    const clips = this.getVideoClipsByResident(residentId);

    return {
      totalEventsToday: todayEvents.length,
      urgentEvents: events.filter((e) => e.severity === "urgent").length,
      assistEvents: events.filter((e) => e.severity === "assist").length,
      watchEvents: events.filter((e) => e.severity === "watch").length,
      totalVideoClips: clips.length,
      latestVideoClipAt: clips[0]?.createdAt ?? null,
      mostCommonEventType: mostCommon ? mostCommon[0] : null,
      lastEventAt: events[0]?.createdAt ?? null,
      recentEvents: events.slice(0, 20),
      videoClips: clips.slice(0, 10),
    };
  }
}

export const MOCK_VIDEO_CLIPS: VideoClip[] = [
  {
    _id: "clip_001",
    eventId: "event_001",
    residentId: "resident_001",
    residentName: "Eleanor Brooks",
    room: "Room 204",
    severity: "urgent",
    eventType: "possible_fall",
    s3Key: "critical-events/resident_001/event_001_demo.webm",
    bucket: "demo-bucket",
    contentType: "video/webm",
    durationSeconds: 18,
    clipStartTime: new Date(Date.now() - 3.3 * 60 * 60 * 1000).toISOString(),
    clipEndTime: new Date(Date.now() - 3.0 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  },
  {
    _id: "clip_002",
    eventId: "event_003",
    residentId: "resident_002",
    residentName: "Robert Hayes",
    room: "Room 118",
    severity: "assist",
    eventType: "immobility",
    s3Key: "critical-events/resident_002/event_003_demo.webm",
    bucket: "demo-bucket",
    contentType: "video/webm",
    durationSeconds: 15,
    clipStartTime: new Date(Date.now() - 1.7 * 60 * 60 * 1000).toISOString(),
    clipEndTime: new Date(Date.now() - 1.5 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 1.5 * 60 * 60 * 1000).toISOString(),
  },
];

// Local demo data is shared across route bundles and survives hot reloads.
const demoGlobal = globalThis as typeof globalThis & { sensaraStore?: InMemoryStore };

export function getInMemoryStore(): InMemoryStore {
  return (demoGlobal.sensaraStore ??= new InMemoryStore());
}
