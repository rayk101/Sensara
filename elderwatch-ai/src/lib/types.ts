// ─────────────────────────────────────────────────────────────────────────────
// ElderWatch AI — Core Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

// Resident safety severity levels
export const ResidentStatus = {
  STABLE: "stable",
  WATCH: "watch",
  ASSIST: "assist",
  URGENT: "urgent",
} as const;

// Types of safety events that can be detected
export const EventType = {
  FALL_RISK: "fall_risk",
  POSSIBLE_FALL: "possible_fall",
  IMMOBILITY: "immobility",
  WANDERING: "wandering",
  UNSAFE_POSTURE: "unsafe_posture",
  SEIZURE_LIKE_MOTION: "seizure_like_motion",
  OUT_OF_FRAME: "out_of_frame",
  AUDIO_DISTRESS: "audio_distress",
  POSSIBLE_DISTRESS_SOUND: "possible_distress_sound",
  POSSIBLE_FALL_SOUND: "possible_fall_sound",
  POSSIBLE_CHOKING: "possible_choking",
  NORMAL: "normal",
} as const;

export type ResidentStatusValue = (typeof ResidentStatus)[keyof typeof ResidentStatus];
export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

// ─── Mock Resident Profile (MOCK DATA ONLY — not real patient data) ───────────
export interface ResidentProfile {
  id: string;
  active?: boolean;
  monitoringStatus?: string;
  assignedStaffIds?: string[];
  supportedUseCases?: string[];
  monitoringConfig?: { recordingEnabled: boolean; audioEnabled: boolean };
  name: string;
  age: number;
  room: string;
  mobility: string;
  fallRisk: "Low" | "Medium" | "High";
  conditions: string[];
  careNotes: string;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Pose-derived safety signals computed each frame ─────────────────────────
export interface SafetySignals {
  isLyingDown: boolean;
  movementScore: number;          // 0–1: 0 = no movement, 1 = lots of movement
  postureAngle: number;           // degrees from vertical (0 = upright, 90 = horizontal)
  secondsStill: number;           // seconds since last significant movement
  insideSafeZone: boolean;        // whether resident is within the defined safe zone
  visible: boolean;               // whether any pose was detected this frame
  // Time-based signals — populated by useResidentMonitor, undefined in persisted records
  secondsOutsideSafeZone?: number;   // continuous seconds torso center has been outside safe zone
  secondsHighMovement?: number;      // continuous seconds of sustained high movement (seizure detection)
  handsNearThroatSeconds?: number;   // observed seconds with either hand near the neck; excludes occluded intervals
  secondsLyingDown?: number;         // continuous seconds the resident has been detected lying down
  bothArmsHanging?: boolean;       // visible extended arms directed downward
  secondsSlumped?: number;         // continuous leaned torso + both hanging arms
  secondsBadPosture?: number;        // continuous seconds postureAngle has exceeded the watch threshold
  majorBodyMovementScore?: number;   // movement score using only torso/head landmarks (excl. wrists)
  leftHandNearThroat?: boolean;      // left wrist/index within throat proximity this frame
  rightHandNearThroat?: boolean;     // right wrist/index within throat proximity this frame
  bothHandsNearThroat?: boolean;     // both hands near throat simultaneously
}

// ─── Result of applying the safety classifier ────────────────────────────────
export interface SafetyClassification {
  severity: ResidentStatusValue;
  eventType: EventTypeValue;
  reason: string;
  confidence: number; // 0–1
}

// ─── A persisted safety event (stored in MongoDB) ────────────────────────────
export interface SafetyEvent {
  detectionMethod?: "mediapipe_pose_v1";
  _id?: string;
  idempotencyKey?: string;
  sessionId?: string | null;
  status?: "open" | "acknowledged" | "resolved" | "dismissed";
  version?: number;
  sourceEventId?: string;
  episodeId?: string;
  activeEpisodeKey?: string;
  correlationId?: string;
  detectedAt?: string;
  firstUrgentAt?: string | null;
  lastUrgentAt?: string | null;
  recurrenceOf?: string;
  workflow?: {
    video: { status: string; error?: string; updatedAt: string };
    voice: { status: string; error?: string; updatedAt: string };
    messaging: { status: string; recipientIds: string[]; error?: string; updatedAt: string };
    dashboard: { status: string; updatedAt: string };
  };
  initialStatus?: "open";
  resolvedAt?: string | null;
  stateHistory?: Array<{ status: string; at: string; by: string; actorId?: string; reason?: string }>;
  notificationsQueued?: boolean;
  residentId: string;
  residentName: string;
  room: string;
  severity: ResidentStatusValue;
  eventType: EventTypeValue;
  confidence: number;
  reason: string;
  recommendedAction: string;
  signals: SafetySignals;
  source: "live_camera" | "audio_monitor" | "manual" | "multi_feed_demo";
  // Set by the server from the monitoring session, never from an upload request.
  recordingSource?: "live_camera" | "multi_feed_demo";
  audioTranscript?: string | null;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  hasVideoClip?: boolean;
  videoClipId?: string | null;
  videoClip?: VideoClipMeta | null;
  createdAt: string;
}

// ─── Inline video clip metadata embedded in a safety event ───────────────────
export interface VideoClipMeta {
  s3Key: string;
  fileName?: string;
  bucket: string;
  contentType: string;
  clipStartTime: string;
  clipEndTime: string;
  durationSeconds: number;
  recordedDurationSeconds?: number;
  hasEmbeddedVoice?: boolean;
}

// ─── A video clip document stored in the video_clips collection ───────────────
export interface VideoClip {
  _id?: string;
  fileName?: string;
  eventId?: string | null;
  fileSize?: number;
  uploadStatus?: "pending" | "uploaded" | "failed";
  uploadedAt?: string;
  expiresAt?: string;
  footageType?: "post-event";
  residentId: string;
  residentName: string;
  room: string;
  severity: ResidentStatusValue;
  eventType: EventTypeValue;
  s3Key: string;
  bucket: string;
  contentType: string;
  durationSeconds: number;
  clipStartTime: string;
  clipEndTime: string;
  hasAudioTrack?: boolean;
  hasEmbeddedVoice?: boolean;
  recordedDurationSeconds?: number;
  recordingFormatVersion?: number;
  hasVideoTrack?: boolean;
  transcript?: string | null;
  matchedKeywords?: string[];
  matchedAudioTags?: string[];
  createdAt: string;
}

// ─── A caregiver note attached to an event ────────────────────────────────────
export interface CaregiverNote {
  _id?: string;
  residentId: string;
  eventId: string;
  note: string;
  createdBy: string;
  createdAt: string;
}

// ─── Dashboard analytics summary ─────────────────────────────────────────────
export interface DashboardAnalytics {
  totalEventsLast24h: number;
  urgentEventsLast24h: number;
  assistEventsLast24h: number;
  mostFrequentEventType: EventTypeValue | null;
  residentWithMostAlerts: { name: string; room: string; count: number } | null;
}

// ─── Resident event history summary ──────────────────────────────────────────
export interface ResidentHistory {
  totalEventsToday: number;
  urgentEvents: number;
  assistEvents: number;
  watchEvents: number;
  totalVideoClips: number;
  latestVideoClipAt: string | null;
  mostCommonEventType: EventTypeValue | null;
  lastEventAt: string | null;
  recentEvents: SafetyEvent[];
  videoClips: VideoClip[];
}

// ─── Safe zone rectangle in normalized camera coordinates (0–1) ───────────────
export interface SafeZone {
  x: number;      // left edge
  y: number;      // top edge
  width: number;
  height: number;
}

// ─── Pose landmark (mirrors MediaPipe NormalizedLandmark) ────────────────────
export interface PoseLandmark {
  x: number; // normalized 0–1
  y: number; // normalized 0–1
  z: number;
  visibility?: number;
}
