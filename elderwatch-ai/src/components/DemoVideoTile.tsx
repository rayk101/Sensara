"use client";

import { useRef, useState, useEffect } from "react";
import { useVideoPose } from "@/hooks/useVideoPose";
import { POSE_CONNECTIONS } from "@/lib/poseHelpers";
import { useMonitoringSession } from "@/hooks/useMonitoringSession";
import { useVideoRecorder } from "@/hooks/useVideoRecorder";
import { useDemoPlayback } from "@/hooks/useDemoPlayback";
import type { SafetyEvent } from "@/lib/types";

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

export default function DemoVideoTile({ config, onStatusChange, onTogglePlayback, isPaused = false }: DemoVideoTileProps) {
  const { sessionId, sessionError } = useMonitoringSession(config.residentId, !isPaused, "multi_feed_demo", config.id);
  const [capturedStream, setCapturedStream] = useState<MediaStream | null>(null);
  const [savedEvent, setSavedEvent] = useState<SafetyEvent | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoError, setVideoError] = useState(false);
  const { status: playbackStatus, setStatus: setPlaybackStatus, retry: retryPlayback } = useDemoPlayback(videoRef, isPaused, sessionId);
  const pose = useVideoPose(videoRef, !isPaused && !!sessionId && !videoError);
  const currentStatus = pose.observation;
  const lastPose = pose.lastFrame;
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const recording = useVideoRecorder(capturedStream, savedEvent, null, isPaused, setSavedEvent, "multi_feed_demo");
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

  const severity = !isPaused && currentStatus.available ? currentStatus.severity : "unknown";
  const statusLabel = isPaused ? "Paused" : videoError ? "Video unavailable" : sessionError ? "Connection unavailable"
    : !sessionId ? "Connecting" : playbackStatus === "blocked" ? "Playback blocked"
    : !currentStatus.available ? (pose.status === "loading" ? "Loading tracking" : "Tracking unavailable")
    : severity === "stable" ? "Monitoring" : severity === "urgent" ? "Critical" : severity === "assist" ? "Needs assistance" : "Watching";
  const problem = sessionError || pose.error || saveMsg;

  return (
    <article data-feed-id={config.id} data-observation={currentStatus.available ? currentStatus.severity : "unknown"}
      data-tracking={pose.status} className={`camera-card camera-card--${severity}`} aria-label={`${config.resident}, ${config.room}`}>
      <header className="camera-card-header">
        <div><p>{config.room}</p><h2>{config.resident}</h2></div>
        <span className="risk-badge">{config.risk}</span>
      </header>
      <div className="camera-media">
        <video ref={videoRef} src={`/demo-videos/${config.videoFile}`} muted loop playsInline
          onError={() => setVideoError(true)}
          onPlaying={() => { setPlaybackStatus("playing"); setVideoError(false); }}
          onPause={() => setPlaybackStatus("paused")} onWaiting={() => setPlaybackStatus("starting")} />
        {lastPose?.landmarks && currentStatus.available && currentStatus.signals.visible && (
          <svg aria-label="Tracked body landmarks" className="pose-overlay" viewBox="0 0 16 9" preserveAspectRatio="xMidYMid slice">
            {POSE_CONNECTIONS.map(([a, b]) => {
              const p = lastPose.landmarks![a], q = lastPose.landmarks![b];
              return p && q && (p.visibility ?? 0) >= .5 && (q.visibility ?? 0) >= .5
                ? <line key={`${a}-${b}`} x1={p.x * 16} y1={p.y * 9} x2={q.x * 16} y2={q.y * 9} stroke="#86d1d0" strokeWidth="0.025" /> : null;
            })}
          </svg>
        )}
        <div className="camera-media-top">
          <span className={`feed-badge feed-badge--${severity}`} title={currentStatus.available ? currentStatus.reason : undefined}>{statusLabel}</span>
          <span className="feed-source">RECORDED</span>
        </div>
        {videoError ? <div className="camera-empty">
          <p>Video unavailable</p>
          <button className="quiet-button" onClick={() => { setVideoError(false); videoRef.current?.load(); retryPlayback(); }}>Reload video</button>
        </div> : isPaused ? <button className="feed-play" onClick={onTogglePlayback}
          aria-label={`Play ${config.resident} feed`} aria-describedby="monitoring-consent">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
        </button> : playbackStatus === "blocked" ? <button className="feed-retry" onClick={retryPlayback}>Retry playback</button>
          : <button className="feed-pause" onClick={onTogglePlayback} aria-label={`Pause ${config.resident} feed`}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>
          </button>}
        {(problem || recording.statusMessage) && <p role="status" className="feed-message">{problem || recording.statusMessage}</p>}
        {!isPaused && currentStatus.available && currentStatus.severity !== "stable" && !problem && !recording.statusMessage && (
          <p className="feed-message">{EVENT_LABELS[currentStatus.eventType] ?? currentStatus.eventType}</p>
        )}
      </div>
    </article>
  );
}
