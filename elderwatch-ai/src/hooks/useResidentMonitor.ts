"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { DEFAULT_SAFE_ZONE } from "@/lib/poseHelpers";
import { analyzePoseWindow, POSE_POLICY, type PoseFrame } from "@/lib/poseEvidence";
import type { PoseFrameContext } from "./useVideoPose";
import type {
  PoseLandmark,
  SafetySignals,
  SafetyClassification,
  SafetyEvent,
  ResidentProfile,
  SafeZone,
} from "@/lib/types";

const MAX_TIMELINE_LENGTH = 50;

interface MonitorOptions {
  isPaused?: boolean;
  sessionId?: string | null;
  seizureDetectionEnabled?: boolean;
}

interface MonitorState {
  observationAvailable: boolean;
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


  const frames = useRef<PoseFrame[]>([]);
  const lastObservation = useRef({ at: 0, severity: "", sessionId: "" });
  const pending = useRef(false);
  const [state, setState] = useState<MonitorState>(() => ({
    observationAvailable: false,
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

  const resetTimers = useCallback(() => { frames.current = []; }, []);

  useEffect(() => {
    resetTimers();
    lastObservation.current = { at: 0, severity: "", sessionId: "" };
    setLatestEvent(null);
    setPersistenceError(null);
    setState(prev => ({ ...prev, observationAvailable: false, timeline: [], classification: {
      severity: "stable", eventType: "normal", reason: "Waiting for camera…", confidence: 0,
    } }));
  }, [resident?.id, resetTimers]);

  useEffect(() => {
    resetTimers();
    setState(prev => ({ ...prev, observationAvailable: false,
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

  // Runs in the worker-result callback; no chained landmark-state effect.
  const processFrame = useCallback((landmarks: PoseLandmark[] | null, context?: PoseFrameContext) => {
    if (!resident || isPaused) return;
    const now = Date.now();
    const time = context?.time ?? performance.now() / 1000;
    const aspect = context?.aspect ?? 4 / 3;
    if (time <= (frames.current.at(-1)?.time ?? -1)) frames.current = [];
    frames.current = [...frames.current.filter(f => time - f.time <= POSE_POLICY.windowSeconds), { time, landmarks }].slice(-80);
    const measured = analyzePoseWindow(frames.current, aspect, safeZone);
    setState(prev => ({ ...prev, observationAvailable: measured.available, signals: measured.signals, classification: measured }));
    const observed = measured.available ? measured.severity : "unknown";
    if (sessionId && !pending.current && (now - lastObservation.current.at >= 1000 || observed !== lastObservation.current.severity || sessionId !== lastObservation.current.sessionId)) {
      pending.current = true;
      lastObservation.current = { at: now, severity: observed, sessionId };
      const patientId = resident.id;
      void fetch("/api/observations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        source: "live_camera", sessionId, residentId: patientId, poseFrames: frames.current,
        videoTime: time, aspect, safeZone, sourceEventId: crypto.randomUUID(), detectedAt: new Date(now).toISOString(),
      }), signal: AbortSignal.timeout(10000) }).then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error();
        if (patientId === residentIdRef.current) { if (body.event) upsertEvent(body.event); setPersistenceError(null); }
      }).catch(() => { if (patientId === residentIdRef.current) setPersistenceError("Observation not saved. Remote notification is unavailable or unconfirmed."); })
        .finally(() => { pending.current = false; });
    }
  }, [resident, safeZone, sessionId, upsertEvent, isPaused]);

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
