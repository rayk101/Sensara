"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import PoseCamera from "@/components/PoseCamera";
import { DEFAULT_SAFE_ZONE, clampSafeZone } from "@/lib/poseHelpers";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { useResidentMonitor } from "@/hooks/useResidentMonitor";
import { useMonitoringSession } from "@/hooks/useMonitoringSession";
import IncidentCenter from "@/components/IncidentCenter";
import SignIn from "@/components/SignIn";
import { useVideoRecorder, type LiveCaptureTrigger } from "@/hooks/useVideoRecorder";
import RecordingNotice from "@/components/RecordingNotice";
import AudioMonitor from "@/components/AudioMonitor";
import MultiFeedDemo from "@/components/MultiFeedDemo";
import { useDemoControls } from "@/hooks/useDemoControls";
import { DEMO_SCENARIOS } from "@/lib/demoScenarios";
import { residentDisplayName } from "@/lib/residentDisplay";
import type { ResidentProfile, SafetyEvent, SafeZone } from "@/lib/types";

const SAFE_ZONE_KEY = "elderwatch_safe_zone";
function loadSafeZone(): SafeZone {
  try {
    const zone = JSON.parse(localStorage.getItem(SAFE_ZONE_KEY) ?? "null");
    if (zone && [zone.x, zone.y, zone.width, zone.height].every(value => typeof value === "number")) return clampSafeZone(zone);
  } catch { /* Keep the default zone if local preferences are unavailable. */ }
  return DEFAULT_SAFE_ZONE;
}

type MainTab = "multi-feed" | "live-camera" | "reports";
const TABS: Array<{ id: MainTab; label: string }> = [
  { id: "multi-feed", label: "Command Center" },
  { id: "live-camera", label: "Live Camera" },
  { id: "reports", label: "Reports" },
];

export default function Dashboard() {
  const [residents, setResidents] = useState<ResidentProfile[]>([]);
  const [mainTab, setMainTab] = useState<MainTab>("multi-feed");
  const [selectedResidentId, setSelectedResidentId] = useState("resident_001");
  const [isPaused, setIsPaused] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [patientError, setPatientError] = useState("");
  const [patientLoadAttempt, setPatientLoadAttempt] = useState(0);
  const demoFeedIds = useMemo(() => DEMO_SCENARIOS.filter(scenario => residents.some(resident => resident.id === scenario.residentId && resident.active !== false)).map(scenario => scenario.id), [residents]);
  const demo = useDemoControls(demoFeedIds, mainTab === "multi-feed");
  const selectedResident = residents.find(resident => resident.id === selectedResidentId) ?? residents[0];

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 12000);
    setPatientError("");
    fetch("/api/residents", { signal: controller.signal })
      .then(async response => {
        if (response.status === 401) { if (!disposed) setAuthRequired(true); return null; }
        if (!response.ok) throw new Error("The patient database is temporarily unreachable. Please retry in a moment.");
        return response.json();
      })
      .then(data => {
        if (disposed || !data) return;
        const active: ResidentProfile[] = Array.isArray(data.residents) ? data.residents.filter((resident: ResidentProfile) => resident.active !== false) : [];
        if (active.length) {
          setResidents(active);
          setSelectedResidentId(id => active.some(resident => resident.id === id) ? id : active[0].id);
        } else setPatientError("No active residents are assigned to this account.");
      })
      .catch((error: unknown) => {
        if (!disposed) setPatientError(controller.signal.aborted ? "Loading took too long. Please retry." : error instanceof Error ? error.message : "Could not reach the server.");
      })
      .finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [patientLoadAttempt]);

  const changeTab = (tab: MainTab) => {
    setIsPaused(tab !== "live-camera");
    setMainTab(tab);
  };
  const toggleMonitoring = () => {
    if (mainTab === "multi-feed") {
      if (demo.anyRunning) demo.pauseAll(); else demo.startAll();
    } else setIsPaused(paused => !paused);
  };

  if (authRequired) return <SignIn />;
  if (!selectedResident) return <main className="connection-screen"><section>
    <h1>Sensara</h1>
    <p role={patientError ? "alert" : "status"}>{patientError || "Connecting to resident records…"}</p>
    {patientError && <button className="quiet-button" onClick={() => setPatientLoadAttempt(attempt => attempt + 1)}>Retry connection</button>}
  </section></main>;

  return <div className="command-app">
    <header className="command-header">
      <div className="command-shell command-header-inner">
        <a href="/" className="command-brand" aria-label="Sensara home">
          <svg viewBox="0 0 48 52" fill="none" aria-hidden="true">
            <path d="M4 47V26C4 13.8 12.9 4 24 4s20 9.8 20 22v21" stroke="#304f5c" strokeWidth="5" strokeLinecap="round" />
            <path d="M15 47V33c0-6 3.8-10 9-10s9 4 9 10v14" stroke="#59a69e" strokeWidth="5" strokeLinecap="round" />
            <circle cx="24" cy="16" r="4" fill="#ec896e" />
          </svg>
          <span>Senserra</span>
        </a>
        <nav className="command-nav" aria-label="Main navigation">
          {TABS.map(tab => <button key={tab.id} aria-current={mainTab === tab.id ? "page" : undefined}
            className={mainTab === tab.id ? "active" : ""} onClick={() => changeTab(tab.id)}>{tab.label}</button>)}
        </nav>
      </div>
    </header>

    <main className={`command-shell command-main${mainTab === "live-camera" ? " live-main" : ""}`}>
      {mainTab === "live-camera" && <nav className="live-breadcrumb" aria-label="Breadcrumb">
        <button onClick={() => changeTab("multi-feed")}>Command Center</button>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
        <span aria-current="page">Live Camera</span>
      </nav>}
      <div className="command-title-row">
        <h1>{mainTab === "live-camera" ? "Live Camera Feed" : TABS.find(tab => tab.id === mainTab)?.label}</h1>
        {mainTab === "multi-feed" && <button className="monitor-toggle" onClick={toggleMonitoring} aria-describedby="monitoring-consent">
          {demo.anyRunning ? "Pause feeds" : "Start feeds"}
        </button>}
      </div>
      <p id="monitoring-consent" className="sr-only">Starting a feed enables monitoring, critical incident recordings and configured alerts.</p>
      <div className={`command-layout${mainTab === "reports" ? " command-layout--reports" : mainTab === "live-camera" ? " command-layout--live" : ""}`}>
        <div className="command-feeds" hidden={mainTab === "reports"}>
          <div hidden={mainTab !== "multi-feed"}>
            <MultiFeedDemo residents={residents} runningFeedIds={demo.runningFeedIds} onToggleFeed={demo.toggleFeed} />
          </div>
          <div hidden={mainTab !== "live-camera"}>
            <LiveCamera resident={selectedResident} residents={residents} onSelectResident={setSelectedResidentId}
              enabled={mainTab === "live-camera" && !isPaused} onStart={() => setIsPaused(false)} onPause={() => setIsPaused(true)} />
          </div>
        </div>
        <aside className="command-sidebar" aria-label="Alerts and notifications">
          <IncidentCenter showHistory={mainTab === "reports"} residentId={mainTab === "live-camera" ? selectedResident.id : undefined}
            title={mainTab === "live-camera" ? "Notifications" : undefined} />
        </aside>
      </div>
    </main>
  </div>;
}

function LiveCamera({ resident, residents, onSelectResident, enabled, onStart, onPause }: {
  resident: ResidentProfile; residents: ResidentProfile[]; onSelectResident: (id: string) => void; enabled: boolean; onStart: () => void; onPause: () => void;
}) {
  const [safeZone, setSafeZone] = useState<SafeZone>(DEFAULT_SAFE_ZONE);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [safeZoneEditMode, setSafeZoneEditMode] = useState(false);
  const [cameraId, setCameraId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  useEffect(() => { setSafeZone(loadSafeZone()); }, []);
  const handleSafeZoneChange = useCallback((zone: SafeZone) => {
    const next = clampSafeZone(zone);
    setSafeZone(next);
    try { localStorage.setItem(SAFE_ZONE_KEY, JSON.stringify(next)); } catch { /* Preferences are optional. */ }
  }, []);
  const { sessionId, sessionError } = useMonitoringSession(resident.id, enabled, "live_camera", cameraId || "default-camera", attempt);
  const liveCapture = useRef<Pick<ReturnType<typeof useVideoRecorder>, "beginLiveCapture" | "bindLiveCapture"> | null>(null);
  const onCriticalCapture = useCallback((trigger: LiveCaptureTrigger) => liveCapture.current?.beginLiveCapture(trigger), []);
  const onCriticalPersisted = useCallback((requestId: string, event: SafetyEvent | null) => liveCapture.current?.bindLiveCapture(requestId, event), []);
  const { signals, classification, observationAvailable, processFrame, upsertEvent, persistenceError, latestEvent } = useResidentMonitor(
    resident, safeZone, { isPaused: !enabled, seizureDetectionEnabled: false, sessionId, onCriticalCapture, onCriticalPersisted }
  );
  const { landmarks, videoRef, canvasRef, status, errorMessage, stream, retry } = usePoseDetection(enabled, processFrame, cameraId, resident.id);
  const recording = useVideoRecorder(stream, latestEvent, micStream, !enabled, upsertEvent, "live_camera");
  useEffect(() => { liveCapture.current = { beginLiveCapture: recording.beginLiveCapture, bindLiveCapture: recording.bindLiveCapture }; }, [recording.beginLiveCapture, recording.bindLiveCapture]);
  useEffect(() => {
    if (stream) void navigator.mediaDevices.enumerateDevices().then(devices => setCameras(devices.filter(device => device.kind === "videoinput"))).catch(() => {});
  }, [stream]);
  useEffect(() => {
    if (sessionId && ["no-webcam", "error"].includes(status)) void fetch(`/api/monitoring-sessions/${sessionId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "interrupted" }),
    });
  }, [sessionId, status]);
  const restart = () => { setAttempt(value => value + 1); onStart(); retry(); };

  return <div className="live-camera-view">
    <PoseCamera videoRef={videoRef} canvasRef={canvasRef} landmarks={landmarks} status={status} errorMessage={errorMessage}
      safeZone={safeZone} severity={classification.severity} observationAvailable={observationAvailable && status === "running" && enabled}
      onRetry={restart} editMode={safeZoneEditMode && optionsOpen} onSafeZoneChange={handleSafeZoneChange} insideSafeZone={signals.insideSafeZone}
      presentation="live" detectionLabel={classification.severity === "stable" ? "Monitoring" : classification.severity === "urgent" ? "Critical" : classification.severity === "watch" ? "Watching" : "Needs assistance"}
      monitoringError={sessionError || persistenceError} />
    <div className="live-feed-controls">
      <button className="live-control" onClick={enabled ? onPause : onStart} aria-label={enabled ? "Pause camera" : "Start camera"} title={enabled ? "Pause camera" : "Start camera"}>
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{enabled ? <path d="M6 5h4v14H6zm8 0h4v14h-4z" /> : <path d="m8 5 11 7-11 7z" />}</svg>
      </button>
      <button className="live-control" aria-label="Camera settings" title="Camera settings" aria-expanded={optionsOpen}
        aria-controls="live-camera-settings" onClick={() => setOptionsOpen(open => !open)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 7h16M4 17h16" strokeLinecap="round" /><circle cx="9" cy="7" r="3" fill="#2e4651" /><circle cx="15" cy="17" r="3" fill="#2e4651" /></svg>
      </button>
    </div>
    <div id="live-camera-settings" className="live-settings" hidden={!optionsOpen}>
      <div className="live-settings-title"><h2>Camera settings</h2><button aria-label="Close camera settings" onClick={() => setOptionsOpen(false)}>×</button></div>
      <label>Resident<select value={resident.id} onChange={event => onSelectResident(event.target.value)}>
        {residents.map(person => <option key={person.id} value={person.id}>{residentDisplayName(person.id, person.name)} · {person.room}</option>)}
      </select></label>
      <label>Camera<select value={cameraId} onChange={event => setCameraId(event.target.value)}>
        <option value="">Default camera</option>{cameras.map(camera => <option key={camera.deviceId} value={camera.deviceId}>{camera.label || "Camera"}</option>)}
      </select></label>
      <div className="live-zone-options"><label><input type="checkbox" checked={safeZoneEditMode} onChange={event => setSafeZoneEditMode(event.target.checked)} /> Edit safe zone</label>
        <button className="text-action" onClick={() => handleSafeZoneChange(DEFAULT_SAFE_ZONE)}>Reset</button></div>
      <AudioMonitor sessionId={sessionId} resident={resident} isPaused={!enabled} onEventSaved={upsertEvent} onMicStream={setMicStream} />
    </div>
    <RecordingNotice status={persistenceError && classification.severity === "urgent" ? "error" : recording.recordingStatus}
      message={persistenceError && classification.severity === "urgent" ? persistenceError : recording.statusMessage} />
  </div>;
}
