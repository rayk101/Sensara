"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { getScriptedStatus } from "@/lib/demoScenarios";
import { useMonitoringSession } from "@/hooks/useMonitoringSession";
import { useVideoRecorder } from "@/hooks/useVideoRecorder";
import type { SafetyEvent } from "@/lib/types";
import SafetyBadge from "./SafetyBadge";

export interface DemoFeedConfig {
  id: string;
  room: string;
  resident: string;
  residentId: string;
  risk: string;
  videoFile: string;
}

export interface DemoFeedStatus {
  severity: "stable" | "watch" | "assist" | "urgent";
  eventType: string;
  reason: string;
  confidence: number;
}

interface DemoVideoTileProps {
  config: DemoFeedConfig;
  activeUrgent?: boolean;
  isPaused?: boolean;
  onStatusChange?: (feedId: string, status: DemoFeedStatus) => void;
}

const EVENT_LABELS: Record<string, string> = {
  normal: "Normal",
  possible_fall: "Possible Fall",
  fall_risk: "Fall Risk",
  wandering: "Wandering",
  possible_choking: "Possible Choking",
  unsafe_posture: "Unsafe Posture",
  immobility: "Immobility",
  audio_distress: "Audio Distress",
  possible_distress_sound: "Distress Sound",
};

const SEVERITY_BORDER: Record<string, string> = {
  stable: "border-sensara-border",
  watch: "border-yellow-500 shadow-yellow-500/20 shadow-lg",
  assist: "border-orange-500 shadow-orange-500/30 shadow-xl",
  urgent: "border-red-500 shadow-red-500/40 shadow-2xl",
};

const SEVERITY_HEADER_BG: Record<string, string> = {
  stable: "bg-sensara-forest-800",
  watch: "bg-yellow-900/90",
  assist: "bg-orange-900/90",
  urgent: "bg-red-900/90",
};

export default function DemoVideoTile({ config, onStatusChange, isPaused = false, activeUrgent = false }: DemoVideoTileProps) {
  const { sessionId, sessionError } = useMonitoringSession(config.residentId, !isPaused, "multi_feed_demo", config.id);
  const [capturedStream, setCapturedStream] = useState<MediaStream | null>(null);
  const [savedEvent, setSavedEvent] = useState<SafetyEvent | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentStatus, setCurrentStatus] = useState<DemoFeedStatus>({
    severity: "stable",
    eventType: "normal",
    reason: "No concerning activity detected",
    confidence: 0.95,
  });
  const [videoError, setVideoError] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const recording = useVideoRecorder(capturedStream, savedEvent, null, isPaused, setSavedEvent);
  useEffect(() => {
    const video = videoRef.current as (HTMLVideoElement & { captureStream?: () => MediaStream }) | null;
    if (isPaused || !video || !sessionId) { setCapturedStream(null); return; }
    let stream: MediaStream | undefined;
    const capture = () => { if (video.captureStream) { stream = video.captureStream(); setCapturedStream(stream); } };
    if (video.readyState >= 2) capture(); else video.addEventListener("loadeddata", capture, { once: true });
    return () => { video.removeEventListener("loadeddata", capture); stream?.getTracks().forEach(t => t.stop()); setCapturedStream(null); };
  }, [isPaused, sessionId]);
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPaused) video.pause();
    else void video.play().catch(() => setVideoError(true));
  }, [isPaused]);

  useEffect(() => {
    onStatusChangeRef.current?.(config.id, currentStatus);
  }, [config.id, currentStatus]);

  // Update scripted status on each video timeupdate
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      const newStatus = getScriptedStatus(config.id, video.currentTime);
      setCurrentStatus(prev => {
        if (prev.severity !== newStatus.severity || prev.eventType !== newStatus.eventType) {
          return newStatus;
        }
        return prev;
      });
    };

    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => video.removeEventListener("timeupdate", handleTimeUpdate);
  }, [config.id]);

  const handleSaveDemoEvent = useCallback(async () => {
    if (currentStatus.severity === "stable" || !sessionId) return;
    setIsSaving(true);
    try {
      const res = await fetch("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        source: "multi_feed_demo", sessionId, sourceEventId: `${sessionId}:${currentStatus.eventType}:${currentStatus.severity}`,
        detectedAt: new Date().toISOString(), scenarioId: config.id, videoTime: videoRef.current?.currentTime ?? 0,
        residentId: config.residentId, ...currentStatus,
      }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save incident");
      setSavedEvent(data); setSaveMsg("Saved");
    } catch (e) { setSaveMsg(e instanceof Error ? e.message : "Save failed"); }
    finally { setIsSaving(false); }
  }, [config.id, config.residentId, currentStatus, sessionId]);
  useEffect(() => {
    if (isPaused || !sessionId || videoError) return;
    let stopped = false;
    const observe = async () => {
      try {
        const response = await fetch("/api/observations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ residentId: config.residentId, source: "multi_feed_demo", sessionId, scenarioId: config.id, videoTime: videoRef.current?.currentTime ?? 0, sourceEventId: crypto.randomUUID(), detectedAt: new Date().toISOString() }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Observation could not be saved");
        if (!stopped) { if (body.event) setSavedEvent(body.event); setSaveMsg(null); }
      } catch (error) { if (!stopped) setSaveMsg(error instanceof Error ? error.message : "Persistence unavailable"); }
    };
    void observe(); const timer = setInterval(() => { void observe(); }, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [isPaused, sessionId, config.id, config.residentId, videoError]);

  const priority = activeUrgent ? "urgent" : currentStatus.severity;
  const urgentColor = "#ef4444";
  const watchColor = "#eab308";
  const assistColor = "#f97316";
  const activeColor = currentStatus.severity === "urgent" ? urgentColor : currentStatus.severity === "assist" ? assistColor : watchColor;

  return (
    <div className={`rounded-xl overflow-hidden border-2 transition-all duration-500 ${SEVERITY_BORDER[priority]}`}>
      {(sessionError || recording.statusMessage) && <p role="status" className="bg-amber-50 px-3 py-2 text-xs">{sessionError || recording.statusMessage}</p>}
      {/* Tile header */}
      <div className={`px-3 py-2 flex items-center justify-between gap-2 transition-colors duration-500 ${SEVERITY_HEADER_BG[priority]}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {(isPaused || videoError || !sessionId) && !activeUrgent ? <span className="text-xs text-white">UNKNOWN · Monitoring unavailable</span> : <SafetyBadge severity={priority} size="sm" pulse={priority !== "stable"} />}
            <span className="text-white text-xs font-semibold">{config.room}</span>
            <span className="text-[9px] text-gray-400 bg-gray-700/60 border border-gray-600/40 rounded px-1.5 py-0.5 shrink-0">
              SIMULATED FEED
            </span>
          </div>
          <p className="text-gray-400 text-[11px] mt-0.5 truncate">{config.resident} · {config.risk}</p>
        </div>
        {currentStatus.severity !== "stable" && (
          <div className="shrink-0 text-right">
            <p className="text-[10px] font-semibold" style={{ color: activeColor }}>
              {EVENT_LABELS[currentStatus.eventType] ?? currentStatus.eventType}
            </p>
            <p className="text-[9px] text-gray-500">{Math.round(currentStatus.confidence * 100)}/100 heuristic</p>
          </div>
        )}
      </div>

      {/* Video */}
      <div className="relative bg-gray-900" style={{ aspectRatio: "16/9" }}>
        {!videoError ? (
          <video
            ref={videoRef}
            src={`/demo-videos/${config.videoFile}`}
            autoPlay={!isPaused}
            muted
            loop
            playsInline
            onError={() => setVideoError(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900 text-center px-4 gap-2">
            <svg className="w-10 h-10 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.893L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
            <div>
              <p className="text-gray-400 text-xs font-medium">Demo video missing</p>
              <p className="text-gray-600 text-[10px] mt-1">Add file to:</p>
              <p className="text-gray-600 text-[10px] font-mono bg-gray-800/60 rounded px-2 py-0.5 mt-1">
                public/demo-videos/{config.videoFile}
              </p>
            </div>
          </div>
        )}

        {/* Alert overlay */}
        {currentStatus.severity === "urgent" && !videoError && (
          <div className="absolute top-2 left-2 right-2 bg-red-950/85 border border-red-700/70 rounded-lg px-2.5 py-1.5">
            <p className="text-red-300 text-[10px] font-bold">
              ⚠ {EVENT_LABELS[currentStatus.eventType] ?? "URGENT"}
            </p>
            <p className="text-red-200/75 text-[9px] mt-0.5 line-clamp-2">{currentStatus.reason}</p>
          </div>
        )}
        {currentStatus.severity === "watch" && !videoError && (
          <div className="absolute top-2 left-2 bg-yellow-950/85 border border-yellow-700/70 rounded-lg px-2 py-1">
            <p className="text-yellow-300 text-[10px] font-medium">
              ● {EVENT_LABELS[currentStatus.eventType] ?? "WATCH"}
            </p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 bg-sensara-forest-900/95 flex items-center justify-between gap-2">
        <p className="text-[10px] text-sensara-forest-300 truncate flex-1 min-w-0">
          {currentStatus.severity !== "stable" ? currentStatus.reason : (isPaused ? "Monitoring paused" : "Monitoring…")}
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          {saveMsg && (
            <span className={`text-[10px] ${saveMsg === "Saved" ? "text-green-400" : "text-gray-400"}`}>
              {saveMsg}
            </span>
          )}
          <button
            onClick={handleSaveDemoEvent}
            disabled={isSaving || currentStatus.severity === "stable"}
            className="text-[10px] bg-sensara-forest-700 hover:bg-sensara-forest-600 disabled:opacity-40 disabled:cursor-not-allowed text-white border border-sensara-forest-500 rounded px-2 py-1 transition-colors whitespace-nowrap"
          >
            {isSaving ? "Saving…" : "Save Event"}
          </button>
        </div>
      </div>
    </div>
  );
}
