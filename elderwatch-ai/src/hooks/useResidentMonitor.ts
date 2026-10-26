"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { DEFAULT_SAFE_ZONE } from "@/lib/poseHelpers";
import { analyzePoseWindow, POSE_POLICY, type PoseFrame, type PoseDiagnostics } from "@/lib/poseEvidence";
import type { PoseFrameContext } from "./useVideoPose";
import type { LiveCaptureTrigger } from "./useVideoRecorder";
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
  onCriticalCapture?: (trigger: LiveCaptureTrigger) => void;
  onCriticalPersisted?: (requestId: string, event: SafetyEvent | null) => void;
}

interface MonitorState {
  observationAvailable: boolean;
  diagnostics: PoseDiagnostics | null;
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
  const captureCallbacks = useRef(options);
  useEffect(() => { captureCallbacks.current = options; }, [options]);
  const criticalEdge = useRef({ urgent: false, category: "", nonUrgentSince: 0 });
  const observationQueue = useRef<Array<{ body: Record<string, unknown>; patientId: string; captureId?: string; generation: number; recovery?: boolean; endpoint?: "/api/events" }>>([]);
  const generation = useRef(0);
  const [state, setState] = useState<MonitorState>(() => ({
    observationAvailable: false,
    diagnostics: null,
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
    setState(prev => ({ ...prev, observationAvailable: false, diagnostics: null, timeline: [], classification: {
      severity: "stable", eventType: "normal", reason: "Waiting for camera…", confidence: 0,
    } }));
  }, [resident?.id, resetTimers]);

  useEffect(() => {
    resetTimers();
    const activeGeneration = ++generation.current;
    for (const item of observationQueue.current) if (item.captureId) captureCallbacks.current.onCriticalPersisted?.(item.captureId, null);
    observationQueue.current = [];
    criticalEdge.current = { urgent: false, category: "", nonUrgentSince: 0 };
    setState(prev => ({ ...prev, observationAvailable: false, diagnostics: null,
      signals: { ...prev.signals, visible: false, secondsStill: 0 },
      classification: {
        severity: "stable", eventType: "normal", confidence: 0,
        reason: isPaused ? "Monitoring paused" : "Waiting for camera…",
      },
    }));
    return () => {
      generation.current = activeGeneration + 1;
      for (const item of observationQueue.current) if (item.captureId) captureCallbacks.current.onCriticalPersisted?.(item.captureId, null);
      observationQueue.current = [];
    };
  }, [isPaused, resident?.id, sessionId, resetTimers]);

  const upsertEvent = useCallback((event: SafetyEvent) => {
    if (event.residentId !== residentIdRef.current) return;
    setLatestEvent(event);
    setState(prev => ({ ...prev, timeline: [event, ...prev.timeline.filter(item => item._id !== event._id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_TIMELINE_LENGTH) }));
  }, []);

  const sendObservation = useCallback((item: typeof observationQueue.current[number]) => {
    if (item.recovery && pending.current) {
      // Retain a bounded, chronological recovery window behind a slow request.
      // The server needs multiple non-urgent samples to rearm an open episode.
      const tail = observationQueue.current;
      let firstRecovery = tail.length;
      while (firstRecovery > 0 && tail[firstRecovery - 1].recovery) firstRecovery--;
      if (tail.length - firstRecovery >= 4) tail.splice(firstRecovery, 1);
    }
    observationQueue.current.push(item);
    if (pending.current) return;
    pending.current = true;
    void (async () => {
      try {
        while (observationQueue.current.length) {
          const next = observationQueue.current.shift()!;
          try {
            const response = await fetch(next.endpoint ?? "/api/observations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next.body), signal: AbortSignal.timeout(10000) });
            const body = await response.json();
            if (!response.ok) throw new Error();
            const saved = next.endpoint ? body : body.event;
            const current = next.generation === generation.current && next.patientId === residentIdRef.current;
            if (next.captureId) captureCallbacks.current.onCriticalPersisted?.(next.captureId, current ? saved ?? null : null);
            if (current) { if (saved) upsertEvent(saved); setPersistenceError(null); }
          } catch {
            if (next.captureId) captureCallbacks.current.onCriticalPersisted?.(next.captureId, null);
            if (next.generation === generation.current && next.patientId === residentIdRef.current) setPersistenceError("Observation not saved. Remote notification is unavailable or unconfirmed.");
          }
        }
      } finally { pending.current = false; }
    })();
  }, [upsertEvent]);

  // Runs in the worker-result callback; no chained landmark-state effect.
  const processFrame = useCallback((landmarks: PoseLandmark[] | null, context?: PoseFrameContext) => {
    if (!resident || isPaused) return;
    const now = Date.now();
    const time = context?.time ?? performance.now() / 1000;
    const aspect = context?.aspect ?? 4 / 3;
    if (time <= (frames.current.at(-1)?.time ?? -1)) frames.current = [];
    frames.current = [...frames.current.filter(f => time - f.time <= POSE_POLICY.windowSeconds), { time, landmarks }].slice(-80);
    const measured = analyzePoseWindow(frames.current, aspect, safeZone);
    setState(prev => ({ ...prev, observationAvailable: measured.available, diagnostics: measured.diagnostics ?? null, signals: measured.signals, classification: measured }));
    const observed = measured.available ? measured.severity : "unknown";
    let trigger: LiveCaptureTrigger | undefined;
    if (sessionId && measured.available && measured.severity === "urgent") {
      const category = ["possible_fall", "fall_risk", "unsafe_posture"].includes(measured.eventType) ? "fall" : measured.eventType;
      if ((!criticalEdge.current.urgent || criticalEdge.current.category !== category) && resident.monitoringConfig?.recordingEnabled !== false) {
        trigger = { requestId: crypto.randomUUID(), residentId: resident.id, detectedAt: new Date(now).toISOString() };
        captureCallbacks.current.onCriticalCapture?.(trigger);
      }
      criticalEdge.current = { urgent: true, category, nonUrgentSince: 0 };
    } else if (measured.available) {
      if (!criticalEdge.current.nonUrgentSince) criticalEdge.current.nonUrgentSince = now;
      if (now - criticalEdge.current.nonUrgentSince >= 2000) criticalEdge.current.urgent = false;
    } else criticalEdge.current.nonUrgentSince = 0;
    const recovery = !!criticalEdge.current.category && measured.available && measured.severity !== "urgent";
    const queueRecovery = recovery && pending.current && (now - lastObservation.current.at >= 1000 || criticalEdge.current.nonUrgentSince === now);
    if (sessionId && (trigger || queueRecovery || (!pending.current && (now - lastObservation.current.at >= 1000 || observed !== lastObservation.current.severity || sessionId !== lastObservation.current.sessionId)))) {
      lastObservation.current = { at: now, severity: observed, sessionId };
      const patientId = resident.id;
      sendObservation({ patientId, captureId: trigger?.requestId, generation: generation.current, recovery, body: {
        source: "live_camera", sessionId, residentId: patientId, poseFrames: frames.current,
        videoTime: time, aspect, safeZone, sourceEventId: trigger?.requestId ?? crypto.randomUUID(), detectedAt: trigger?.detectedAt ?? new Date(now).toISOString(),
      } });
    }
  }, [resident, safeZone, sessionId, sendObservation, isPaused]);

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
    if (!resident || isPaused || !sessionId) return;
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
    const trigger = { requestId: crypto.randomUUID(), residentId: resident.id, detectedAt: new Date().toISOString() };
    if (severity === "urgent" && resident.monitoringConfig?.recordingEnabled !== false) captureCallbacks.current.onCriticalCapture?.(trigger);
    sendObservation({ endpoint: "/api/events", patientId: resident.id, captureId: trigger.requestId, generation: generation.current, body: {
      source: "manual", manualTrigger: true, detectedAt: trigger.detectedAt, sessionId, idempotencyKey: trigger.requestId,
      residentId: resident.id, residentName: resident.name, room: resident.room, ...demoClassification, signals: demoSignals,
    } });
    setState(prev => ({ ...prev, classification: demoClassification }));
  }, [resident, sendObservation, isPaused, sessionId]);

  return { ...state, processFrame, injectDemoEvent, upsertEvent, refreshHistory, persistenceError, latestEvent };
}
