"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { useVideoPose } from "@/hooks/useVideoPose";
import { POSE_CONNECTIONS } from "@/lib/poseHelpers";
import { useMonitoringSession } from "@/hooks/useMonitoringSession";
import { useVideoRecorder } from "@/hooks/useVideoRecorder";
import { useDemoPlayback } from "@/hooks/useDemoPlayback";
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
  available?: boolean;
}

interface DemoVideoTileProps {
  config: DemoFeedConfig;
  activeUrgent?: boolean;
  isPaused?: boolean;
  onTogglePlayback: () => void;
  onStatusChange?: (feedId: string, status: DemoFeedStatus) => void;
}

const EVENT_LABELS: Record<string, string> = {
  normal: "Normal",
  possible_fall: "Possible Fall",
  fall_risk: "Fall Risk",
  wandering: "Wandering",
  out_of_frame: "Person out of view",
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

export default function DemoVideoTile({ config, onStatusChange, onTogglePlayback, isPaused = false, activeUrgent = false }: DemoVideoTileProps) {
  const { sessionId, sessionError } = useMonitoringSession(config.residentId, !isPaused, "multi_feed_demo", config.id);
  const [capturedStream, setCapturedStream] = useState<MediaStream | null>(null);
  const [savedEvent, setSavedEvent] = useState<SafetyEvent | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoError, setVideoError] = useState(false);
  const { status: playbackStatus, setStatus: setPlaybackStatus, retry: retryPlayback } = useDemoPlayback(videoRef, isPaused, sessionId);
  const pose = useVideoPose(videoRef, !isPaused && !!sessionId && !videoError);
  const currentStatus = pose.observation;
  const lastPose = pose.lastFrame;
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
    onStatusChangeRef.current?.(config.id, currentStatus);
  }, [config.id, currentStatus]);

  const handleSaveDemoEvent = useCallback(async () => {
    if (!currentStatus.available || currentStatus.severity === "stable" || !sessionId) return;
    setIsSaving(true);
    try {
      const res = await fetch("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        source: "multi_feed_demo", sessionId, sourceEventId: `${sessionId}:${currentStatus.eventType}:${currentStatus.severity}`,
        detectedAt: new Date().toISOString(), scenarioId: config.id, videoTime: pose.frames.current.at(-1)?.time ?? 0, poseFrames: pose.frames.current,
        residentId: config.residentId, ...currentStatus,
      }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save incident");
      setSavedEvent(data); setSaveMsg("Saved");
    } catch (e) { setSaveMsg(e instanceof Error ? e.message : "Save failed"); }
    finally { setIsSaving(false); }
  }, [config.id, config.residentId, currentStatus, sessionId, pose.frames]);
  useEffect(() => {
    if (isPaused || !sessionId || videoError || playbackStatus !== "playing") return;
    let stopped = false, busy = false;
    const observe = async () => {
      if (busy || !pose.frames.current.length) return;
      busy = true;
      try {
        const response = await fetch("/api/observations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ residentId: config.residentId, source: "multi_feed_demo", sessionId, scenarioId: config.id, videoTime: pose.frames.current.at(-1)?.time ?? 0, poseFrames: pose.frames.current, sourceEventId: crypto.randomUUID(), detectedAt: new Date().toISOString() }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Observation could not be saved");
        if (!stopped) { if (body.event) setSavedEvent(body.event); setSaveMsg(null); }
      } catch (error) { if (!stopped) setSaveMsg(error instanceof Error ? error.message : "Persistence unavailable"); }
      finally { busy = false; }
    };
    void observe(); const timer = setInterval(() => { void observe(); }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [isPaused, sessionId, config.id, config.residentId, videoError, playbackStatus, pose.frames]);

  const priority = currentStatus.severity;
  const urgentColor = "#ef4444";
  const watchColor = "#eab308";
  const assistColor = "#f97316";
  const activeColor = currentStatus.severity === "urgent" ? urgentColor : currentStatus.severity === "assist" ? assistColor : watchColor;

  return (
    <div data-feed-id={config.id} data-observation={currentStatus.available ? currentStatus.severity : "unknown"} data-tracking={pose.status} className={`rounded-xl overflow-hidden border-2 transition-all duration-500 ${currentStatus.available ? SEVERITY_BORDER[priority] : "border-slate-400"}`}>
      {(sessionError || pose.error || recording.statusMessage) && <p role="status" className="bg-amber-50 px-3 py-2 text-xs">{sessionError || pose.error || recording.statusMessage}</p>}
      {/* Tile header */}
      <div className={`px-3 py-2 flex items-center justify-between gap-2 transition-colors duration-500 ${currentStatus.available ? SEVERITY_HEADER_BG[priority] : "bg-slate-700"}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {!currentStatus.available ? <span className="text-xs text-white">UNKNOWN · {pose.status === "loading" ? "Loading body tracking" : "Tracking unavailable"}</span> : <><span className="text-[10px] text-white">{isPaused ? "Last observation" : "Observation"}</span><SafetyBadge severity={priority} size="sm" pulse={!isPaused && priority !== "stable"} /></>}
            <span className="text-white text-xs font-semibold">{config.room}</span>
            <span className="text-[9px] text-gray-400 bg-gray-700/60 border border-gray-600/40 rounded px-1.5 py-0.5 shrink-0">
              RECORDED VIDEO · BODY TRACKING
            </span>
          </div>
          <p className="text-gray-400 text-[11px] mt-0.5 truncate">{config.resident} · {config.risk}</p>
        </div>
        {currentStatus.severity !== "stable" && (
          <div className="shrink-0 text-right">
            <p className="text-[10px] font-semibold" style={{ color: activeColor }}>
              {EVENT_LABELS[currentStatus.eventType] ?? currentStatus.eventType}
            </p>
            <p className="text-[9px] text-gray-300">Movement rule · not a diagnosis</p>
          </div>
        )}
      </div>

      {activeUrgent && <p className="border-y border-red-300 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">Patient priority: CRITICAL · Unresolved saved incident. Review on the right; this is separate from the current video observation.</p>}

      {/* Video */}
      <div className="relative bg-gray-900" style={{ aspectRatio: "16/9" }}>
          <video
            ref={videoRef}
            src={`/demo-videos/${config.videoFile}`}
            muted
            loop
            playsInline
            onError={() => setVideoError(true)}
            onPlaying={() => { setPlaybackStatus("playing"); setVideoError(false); }}
            onPause={() => setPlaybackStatus("paused")}
            onWaiting={() => setPlaybackStatus("starting")}
            className="w-full h-full object-cover"
          />
        {lastPose?.landmarks && currentStatus.available && currentStatus.signals.visible && <svg aria-label="Tracked body landmarks" className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
          {POSE_CONNECTIONS.map(([a, b]) => { const p = lastPose.landmarks![a], q = lastPose.landmarks![b]; return p && q && (p.visibility ?? 0) >= .5 && (q.visibility ?? 0) >= .5 ? <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="#38bdf8" strokeWidth="0.003" /> : null; })}
        </svg>}
        {videoError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900 text-center px-4 gap-2">
            <svg className="w-10 h-10 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.893L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
            </svg>
            <div>
              <p className="text-gray-300 text-xs font-medium">Demo video could not load</p>
              <button className="mt-2 rounded border border-gray-500 px-3 py-1 text-xs text-white" onClick={() => { setVideoError(false); videoRef.current?.load(); retryPlayback(); }}>Reload video</button>
            </div>
          </div>
        )}

        {!videoError && (isPaused || !sessionId || playbackStatus !== "playing") && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/40 px-4 text-center text-white">
            <p className="rounded-lg bg-black/60 px-3 py-2 text-sm font-semibold">{isPaused ? "Paused" : sessionError ? "Monitoring unavailable" : !sessionId ? "Starting monitoring…" : playbackStatus === "blocked" ? "Playback paused by browser" : "Loading video…"}</p>
            {isPaused && <p className="text-xs">Play this feed below, or select Start demo to play all four.</p>}
            {!isPaused && sessionId && playbackStatus === "blocked" && <button className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-sensara-forest-900" onClick={retryPlayback}>Retry playback</button>}
          </div>
        )}

        {/* Alert overlay */}
        {currentStatus.severity === "urgent" && !videoError && (
          <div className="absolute top-2 left-2 right-2 bg-red-950/85 border border-red-700/70 rounded-lg px-2.5 py-1.5">
            <p className="text-red-300 text-[10px] font-bold">
              ⚠ CRITICAL · {EVENT_LABELS[currentStatus.eventType] ?? "Movement alert"}
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

      <details className="bg-sensara-forest-900 px-3 py-1 text-[10px] text-white/80">
        <summary className="cursor-pointer">Body tracking details</summary>
        <p>{pose.status} · Torso angle {Math.round(currentStatus.metrics.torsoAngle)}° · Downward shift {currentStatus.metrics.downwardShift.toFixed(2)} torso lengths · Two hands near neck: {currentStatus.metrics.bothHandsNearNeck ? "yes" : "no"} · {currentStatus.metrics.samples} samples</p>
        <p>MediaPipe landmarks measured on video frames. Sustained absence means WATCHING; partial visibility or unavailable tracking means UNKNOWN. Thresholds are engineering heuristics, not medical probabilities.</p>
      </details>
      {/* Footer */}
      <div className="px-3 py-2 bg-sensara-forest-900/95 flex items-center justify-between gap-2">
        <p className="text-[10px] text-sensara-forest-300 truncate flex-1 min-w-0">
          {isPaused ? "Monitoring paused" : !currentStatus.available ? currentStatus.reason : playbackStatus !== "playing" ? "Waiting for video playback" : currentStatus.severity !== "stable" ? currentStatus.reason : "Monitoring…"}
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onTogglePlayback}
            aria-label={`${isPaused ? "Play" : "Pause"} ${config.resident} feed`}
            aria-describedby="monitoring-consent"
            className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-sensara-forest-900 hover:bg-sensara-forest-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {isPaused ? "▶ Play" : "⏸ Pause"}
          </button>
          {saveMsg && (
            <span className={`text-[10px] ${saveMsg === "Saved" ? "text-green-400" : "text-gray-400"}`}>
              {saveMsg}
            </span>
          )}
          <button
            onClick={handleSaveDemoEvent}
            disabled={isSaving || isPaused || !sessionId || !currentStatus.available || currentStatus.severity === "stable"}
            className="text-[10px] bg-sensara-forest-700 hover:bg-sensara-forest-600 disabled:opacity-40 disabled:cursor-not-allowed text-white border border-sensara-forest-500 rounded px-2 py-1 transition-colors whitespace-nowrap"
          >
            {isSaving ? "Saving…" : "Save Event"}
          </button>
        </div>
      </div>
    </div>
  );
}
