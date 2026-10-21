"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import {
  calculatePostureAngle,
  detectLyingDown,
  calculateMovementScore,
  calculateMajorBodyMovementScore,
  isInsideSafeZone,
  isPoseVisible,
  detectHandsNearThroatDetails,
  DEFAULT_SAFE_ZONE,
  DETECTION_THRESHOLDS,
} from "@/lib/poseHelpers";
import { classifyResidentSafety } from "@/lib/classifySafety";
import type {
  PoseLandmark,
  SafetySignals,
  SafetyClassification,
  SafetyEvent,
  ResidentProfile,
  SafeZone,
} from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// useResidentMonitor — Converts raw pose landmarks into safety signals, runs
// the classifier each frame, maintains the local event timeline, and persists
// meaningful events to the backend with per-event-type cooldowns.
// ─────────────────────────────────────────────────────────────────────────────

const MOVEMENT_THRESHOLD = 0.02; // below → count as "still"
const MAX_TIMELINE_LENGTH = 50;

interface MonitorOptions {
  isPaused?: boolean;
  sessionId?: string | null;
  seizureDetectionEnabled?: boolean;
}

interface MonitorState {
  signals: SafetySignals;
  classification: SafetyClassification;
  timeline: SafetyEvent[];
}

export function useResidentMonitor(
  resident: ResidentProfile | null,
  safeZone: SafeZone = DEFAULT_SAFE_ZONE,
  options: MonitorOptions = {}
) {
  const sessionId = options.sessionId;
  const isPaused = options.isPaused ?? false;
  const seizureDetectionEnabled = options.seizureDetectionEnabled ?? false;

  // ── Time-tracking refs ───────────────────────────────────────────────────────
  const prevLandmarksRef = useRef<PoseLandmark[] | null>(null);
  const stillSinceRef = useRef<number | null>(null);
  const outsideSafeZoneSinceRef = useRef<number | null>(null);
  const highMovementSinceRef = useRef<number | null>(null);
  const handsNearThroatSinceRef = useRef<number | null>(null);
  const lyingDownSinceRef = useRef<number | null>(null);
  const badPostureSinceRef = useRef<number | null>(null);

  // Per-event-type last-persisted timestamps (replaces global EVENT_DEBOUNCE_MS)
  const lastPersistedRef = useRef<Record<string, number>>({});
  const lastObservation = useRef({ at: 0, severity: "" });
  // Latch: once possible_fall fires, hold it until the person is clearly upright
  const possibleFallLatchedRef = useRef(false);

  const [state, setState] = useState<MonitorState>(() => ({
    signals: {
      isLyingDown: false,
      movementScore: 1,
      postureAngle: 0,
      secondsStill: 0,
      insideSafeZone: true,
      visible: false,
    },
    classification: {
      severity: "stable",
      eventType: "normal",
      reason: "Waiting for camera…",
      confidence: 0,
    },
    timeline: [],
  }));

  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [latestEvent, setLatestEvent] = useState<SafetyEvent | null>(null);
  const residentIdRef = useRef(resident?.id);
  useEffect(() => { residentIdRef.current = resident?.id; }, [resident?.id]);

  const resetTimers = useCallback(() => {
    prevLandmarksRef.current = null;
    stillSinceRef.current = null;
    outsideSafeZoneSinceRef.current = null;
    highMovementSinceRef.current = null;
    handsNearThroatSinceRef.current = null;
    lyingDownSinceRef.current = null;
    badPostureSinceRef.current = null;
    possibleFallLatchedRef.current = false;
  }, []);

  useEffect(() => {
    resetTimers();
    lastPersistedRef.current = {};
    setLatestEvent(null);
    setPersistenceError(null);
    setState(prev => ({ ...prev, timeline: [], classification: {
      severity: "stable", eventType: "normal", reason: "Waiting for camera…", confidence: 0,
    } }));
  }, [resident?.id, resetTimers]);

  useEffect(() => {
    resetTimers();
    setState(prev => ({ ...prev,
      signals: { ...prev.signals, visible: false, secondsStill: 0 },
      classification: {
        severity: "stable", eventType: "normal", confidence: 0,
        reason: isPaused ? "Monitoring paused" : "Waiting for camera…",
      },
    }));
  }, [isPaused, resetTimers]);

  const upsertEvent = useCallback((event: SafetyEvent) => {
    if (event.residentId !== residentIdRef.current) return;
    setLatestEvent(event);
    setState(prev => ({ ...prev, timeline: [event, ...prev.timeline.filter(item => item._id !== event._id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_TIMELINE_LENGTH) }));
  }, []);

  const saveEvent = useCallback(async (profile: ResidentProfile, classification: SafetyClassification, signals: SafetySignals) => {
    try {
      const saved = await persistEvent(profile, classification, signals, sessionId);
      if (profile.id === residentIdRef.current) {
        upsertEvent(saved);
        setPersistenceError(null);
      }
      return saved;
    } catch {
      if (profile.id === residentIdRef.current) {
        setPersistenceError("Could not save the latest alert. Check the server connection.");
      }
    }
  }, [upsertEvent, sessionId]);

  // Invoked by the camera frame callback, never by a state-derived effect.
  const processFrame = useCallback((landmarks: PoseLandmark[] | null) => {
    if (!resident || isPaused) return;

    const now = Date.now();

    // ── Compute base signals ─────────────────────────────────────────────────
    const visible = landmarks !== null && isPoseVisible(landmarks);

    let movementScore = 0;
    let majorBodyMovementScore = 0;
    let postureAngle = 0;
    let isLyingDown = false;
    let insideSafeZone = true;
    let secondsStill = 0;
    let secondsOutsideSafeZone = 0;
    let secondsHighMovement = 0;
    let handsNearThroatSeconds = 0;
    let leftHandNearThroat = false;
    let rightHandNearThroat = false;
    let bothHandsNearThroat = false;
    let secondsLyingDown = 0;
    let secondsBadPosture = 0;

    if (visible && landmarks) {
      postureAngle = calculatePostureAngle(landmarks);
      isLyingDown = detectLyingDown(landmarks);
      insideSafeZone = isInsideSafeZone(landmarks, safeZone);

      if (prevLandmarksRef.current) {
        movementScore = calculateMovementScore(landmarks, prevLandmarksRef.current);
        majorBodyMovementScore = calculateMajorBodyMovementScore(landmarks, prevLandmarksRef.current);
      } else {
        movementScore = 1;
        majorBodyMovementScore = 1;
      }

      // Track stillness
      if (movementScore < MOVEMENT_THRESHOLD) {
        if (stillSinceRef.current === null) stillSinceRef.current = now;
        secondsStill = (now - stillSinceRef.current) / 1000;
      } else {
        stillSinceRef.current = null;
        secondsStill = 0;
      }

      // Track time outside safe zone
      if (!insideSafeZone) {
        if (outsideSafeZoneSinceRef.current === null) outsideSafeZoneSinceRef.current = now;
        secondsOutsideSafeZone = (now - outsideSafeZoneSinceRef.current) / 1000;
      } else {
        outsideSafeZoneSinceRef.current = null;
        secondsOutsideSafeZone = 0;
      }

      // Track sustained high movement (for experimental seizure detection)
      if (movementScore > DETECTION_THRESHOLDS.seizureMovementThreshold) {
        if (highMovementSinceRef.current === null) highMovementSinceRef.current = now;
        secondsHighMovement = (now - highMovementSinceRef.current) / 1000;
      } else {
        highMovementSinceRef.current = null;
        secondsHighMovement = 0;
      }

      // Track hands near throat (for choking detection)
      const chokingResult = detectHandsNearThroatDetails(landmarks);
      leftHandNearThroat = chokingResult.leftHandNearThroat;
      rightHandNearThroat = chokingResult.rightHandNearThroat;
      bothHandsNearThroat = chokingResult.bothHandsNearThroat;
      if (chokingResult.detected) {
        if (handsNearThroatSinceRef.current === null) handsNearThroatSinceRef.current = now;
        handsNearThroatSeconds = (now - handsNearThroatSinceRef.current) / 1000;
      } else {
        handsNearThroatSinceRef.current = null;
        handsNearThroatSeconds = 0;
      }

      // Track lying-down duration
      if (isLyingDown) {
        if (lyingDownSinceRef.current === null) lyingDownSinceRef.current = now;
        secondsLyingDown = (now - lyingDownSinceRef.current) / 1000;
      } else {
        lyingDownSinceRef.current = null;
        secondsLyingDown = 0;
      }

      // Track bad-posture duration (angle > 30 covers both the watch and assist thresholds)
      if (postureAngle > 30) {
        if (badPostureSinceRef.current === null) badPostureSinceRef.current = now;
        secondsBadPosture = (now - badPostureSinceRef.current) / 1000;
      } else {
        badPostureSinceRef.current = null;
        secondsBadPosture = 0;
      }

      prevLandmarksRef.current = landmarks;
    } else {
      resetTimers();
    }

    const signals: SafetySignals = {
      isLyingDown,
      movementScore,
      postureAngle,
      secondsStill,
      insideSafeZone,
      visible,
      secondsOutsideSafeZone,
      secondsHighMovement,
      handsNearThroatSeconds,
      secondsLyingDown,
      secondsBadPosture,
      majorBodyMovementScore,
      leftHandNearThroat,
      rightHandNearThroat,
      bothHandsNearThroat,
    };

    let classification = classifyResidentSafety(signals, {
      seizureDetectionEnabled: seizureDetectionEnabled,
    });

    // Latch possible_fall — once the resident is detected lying still, keep the
    // urgent classification until they're clearly upright again. Without this,
    // small movements (breathing, shifting) reset secondsStill and the alert
    // oscillates, spamming the timeline and TTS on every 10-second cycle.
    if (classification.eventType === "possible_fall") {
      possibleFallLatchedRef.current = true;
    }
    if (!signals.isLyingDown) {
      possibleFallLatchedRef.current = false;
    }
    if (possibleFallLatchedRef.current && signals.isLyingDown && classification.eventType !== "possible_fall") {
      classification = {
        severity: "urgent",
        eventType: "possible_fall",
        reason: "Resident appears to be lying down with minimal movement — caregiver should check",
        confidence: 0.9,
      };
    }

    if (sessionId && (now - lastObservation.current.at >= 3000 || classification.severity !== lastObservation.current.severity)) {
      lastObservation.current = { at: now, severity: classification.severity };
      const patientId = resident.id;
      void fetch("/api/observations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "live_camera", sessionId, residentId: patientId, signals, sourceEventId: crypto.randomUUID(), detectedAt: new Date(now).toISOString() }) }).then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error();
        if (patientId === residentIdRef.current) { if (body.event) upsertEvent(body.event); setPersistenceError(null); }
      }).catch(() => { if (patientId === residentIdRef.current) setPersistenceError("Observation not saved. Remote notification is unavailable or unconfirmed."); });
    }

    setState(prev => ({ ...prev, signals, classification }));
  }, [resident, safeZone, sessionId, upsertEvent, resetTimers, isPaused, seizureDetectionEnabled]);

  const refreshHistory = useCallback(async () => {
    if (!resident) return;
    const id = resident.id;
    try {
      const res = await fetch(`/api/events?residentId=${encodeURIComponent(id)}&limit=50`);
      if (!res.ok) throw new Error("Could not load history");
      const data: { events: SafetyEvent[] } = await res.json();
      if (residentIdRef.current !== id) return;
      setState(prev => {
        const events = new Map(prev.timeline.map(event => [event._id, event]));
        data.events.forEach(event => events.set(event._id, event));
        return { ...prev, timeline: [...events.values()]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_TIMELINE_LENGTH) };
      });
    } catch {
      if (residentIdRef.current === id) setPersistenceError("Could not load event history.");
    }
  }, [resident]);

  useEffect(() => { void refreshHistory(); }, [refreshHistory]);

  // ── Demo event injector ────────────────────────────────────────────────────
  const injectDemoEvent = useCallback((
    eventType: SafetyEvent["eventType"] = "possible_fall",
    severity: SafetyEvent["severity"] = "urgent"
  ) => {
    if (!resident) return;
    const demoSignals: SafetySignals = {
      isLyingDown: severity === "urgent" && eventType === "possible_fall",
      movementScore: eventType === "seizure_like_motion" ? 0.9 : 0.05,
      postureAngle: eventType === "unsafe_posture" ? 65 : eventType === "possible_choking" ? 30 : 8,
      secondsStill: eventType === "possible_fall" ? 12 : 0,
      insideSafeZone: true,
      visible: true,
      handsNearThroatSeconds: eventType === "possible_choking" ? 5 : 0,
      secondsHighMovement: eventType === "seizure_like_motion" ? 8 : 0,
    };
    const demoClassification: SafetyClassification = {
      severity, eventType, confidence: 0.88,
      reason: `[Demo] ${eventType.replace(/_/g, " ")} simulated via demo trigger`,
    };
    void saveEvent(resident, demoClassification, demoSignals);
    setState(prev => ({ ...prev, classification: demoClassification }));
  }, [resident, saveEvent]);

  return { ...state, processFrame, injectDemoEvent, upsertEvent, refreshHistory, persistenceError, latestEvent };
}

// Only show persisted events in the actionable timeline so IDs match the API.
async function persistEvent(
  resident: ResidentProfile,
  classification: SafetyClassification,
  signals: SafetySignals,
  sessionId?: string | null
): Promise<SafetyEvent> {
  const response = await fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: classification.reason.startsWith("[Demo]") ? "manual" : "live_camera",
      detectedAt: new Date().toISOString(),
      sessionId, idempotencyKey: crypto.randomUUID(),
      residentId: resident.id, residentName: resident.name, room: resident.room,
      ...classification,
      signals,
    }),
  });
  if (!response.ok) throw new Error("Could not save event");
  return response.json();
}
