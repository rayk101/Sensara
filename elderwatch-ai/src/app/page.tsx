"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Image from "next/image";
import PoseCamera from "@/components/PoseCamera";
import { MOCK_RESIDENTS } from "@/lib/mockData";
import { DEFAULT_SAFE_ZONE, clampSafeZone } from "@/lib/poseHelpers";
import { POSE_POLICY } from "@/lib/poseEvidence";
import { usePoseDetection } from "@/hooks/usePoseDetection";
import { useResidentMonitor } from "@/hooks/useResidentMonitor";
import { useMonitoringSession } from "@/hooks/useMonitoringSession";
import Administration from "@/components/Administration";
import IncidentCenter from "@/components/IncidentCenter";
import SignIn from "@/components/SignIn";
import { useVideoRecorder } from "@/hooks/useVideoRecorder";
import ResidentCard from "@/components/ResidentCard";
import EventTimeline from "@/components/EventTimeline";
import AnalyticsCard from "@/components/AnalyticsCard";
import AIAssistant from "@/components/AIAssistant";
import AudioMonitor from "@/components/AudioMonitor";
import MultiFeedDemo, { DemoAlertPanel } from "@/components/MultiFeedDemo";
import { useDemoControls } from "@/hooks/useDemoControls";
import { DEMO_SCENARIOS } from "@/lib/demoScenarios";
import type { FeedAlert } from "@/components/FacilityAlertPanel";
import type { ResidentProfile, SafetyEvent, VideoClip, SafeZone } from "@/lib/types";

// ─── Safe zone localStorage helpers ──────────────────────────────────────────
const SAFE_ZONE_KEY = "elderwatch_safe_zone";

function loadSafeZone(): SafeZone {
  if (typeof window === "undefined") return DEFAULT_SAFE_ZONE;
  try {
    const stored = localStorage.getItem(SAFE_ZONE_KEY);
    if (!stored) return DEFAULT_SAFE_ZONE;
    const z = JSON.parse(stored) as Partial<SafeZone>;
    if (
      typeof z.x !== "number" || typeof z.y !== "number" ||
      typeof z.width !== "number" || typeof z.height !== "number"
    ) return DEFAULT_SAFE_ZONE;
    return clampSafeZone(z as SafeZone);
  } catch {
    return DEFAULT_SAFE_ZONE;
  }
}

function saveSafeZone(z: SafeZone) {
  try { localStorage.setItem(SAFE_ZONE_KEY, JSON.stringify(z)); } catch { /* ignore */ }
}


// ─────────────────────────────────────────────────────────────────────────────
// Sensara — Main Dashboard
// ─────────────────────────────────────────────────────────────────────────────

type MainTab = "multi-feed" | "live-camera";

export default function Dashboard() {
  const [residents, setResidents] = useState<ResidentProfile[]>([]);
  const [selectedResidentId, setSelectedResidentId] = useState<string>(MOCK_RESIDENTS[0].id);
  const [mongoConnected, setMongoConnected] = useState(false);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [photonConfigured, setPhotonConfigured] = useState(false);
  const [photonTestStatus, setPhotonTestStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [photonError, setPhotonError] = useState("");
  const [emailTestStatus, setEmailTestStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [isPaused, setIsPaused] = useState(true);
  const [feedAlerts, setFeedAlerts] = useState<FeedAlert[]>([]);
  const [monitoringConsent, setMonitoringConsent] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [persistedEvents, setPersistedEvents] = useState<SafetyEvent[]>([]);
  const [patientError, setPatientError] = useState("");
  const [patientLoadAttempt, setPatientLoadAttempt] = useState(0);
  const [cameraId, setCameraId] = useState("");
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const seizureDetectionEnabled = false;
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [analyticsRefreshKey, setAnalyticsRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<"monitor" | "history">("monitor");
  const [mainTab, setMainTab] = useState<MainTab>("multi-feed");
  const demoFeedIds = useMemo(() => DEMO_SCENARIOS.filter(scenario => residents.some(resident => resident.id === scenario.residentId && resident.active !== false)).map(scenario => scenario.id), [residents]);
  const demo = useDemoControls(demoFeedIds, mainTab === "multi-feed");
  const controlsPaused = mainTab === "multi-feed" ? !demo.anyRunning : isPaused;
  const startAvailable = mainTab === "multi-feed" ? !demo.allRunning : isPaused;
  const controlLabel = mainTab === "multi-feed" ? (demo.allRunning ? "Pause all" : "Start demo") : (isPaused ? "Start camera" : "Pause monitoring");

  const toggleMonitoring = () => {
    if (mainTab === "multi-feed") {
      if (demo.allRunning) demo.pauseAll();
      else demo.startAll();
      return;
    }
    if (isPaused) setMonitoringConsent(true);
    setIsPaused(paused => !paused);
  };

  // ── Safe zone state with localStorage persistence ────────────────────────────
  const [safeZone, setSafeZone] = useState<SafeZone>(DEFAULT_SAFE_ZONE);
  const [safeZoneEditMode, setSafeZoneEditMode] = useState(false);

  useEffect(() => { setSafeZone(loadSafeZone()); }, []);


  const handleSafeZoneChange = useCallback((z: SafeZone) => {
    const next = clampSafeZone(z);
    setSafeZone(next);
    saveSafeZone(next);
  }, []);
  const resetSafeZone = useCallback(() => handleSafeZoneChange(DEFAULT_SAFE_ZONE), [handleSafeZoneChange]);

  const selectedResident = residents.find((r) => r.id === selectedResidentId) ?? residents[0];

  const monitoringRequested = !isPaused && monitoringConsent && mainTab === "live-camera";
  const { sessionId, sessionError } = useMonitoringSession(selectedResident?.id, monitoringRequested, "live_camera", cameraId || "default-camera", cameraAttempt);
  const monitoringPaused = !monitoringRequested;
  const { signals, classification, timeline, processFrame, injectDemoEvent, upsertEvent, refreshHistory, persistenceError, latestEvent } = useResidentMonitor(
    selectedResident ?? null,
    safeZone,
    { isPaused: monitoringPaused, seizureDetectionEnabled, sessionId }
  );

  // Classify each frame directly so pose and monitoring state render together.
  const { landmarks, videoRef, canvasRef, status: poseStatus, errorMessage, stream, retry: retryCamera } = usePoseDetection(
    monitoringRequested,
    processFrame, cameraId, selectedResident?.id
  );

  const restartCamera = () => { setCameraAttempt(n => n + 1); setIsPaused(false); retryCamera(); };

  useEffect(() => {
    if (sessionId && ["no-webcam", "error"].includes(poseStatus)) {
      void fetch(`/api/monitoring-sessions/${sessionId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "interrupted" }) });
    }
  }, [sessionId, poseStatus]);

  useEffect(() => {
    if (mainTab === "live-camera") void refreshHistory();
  }, [mainTab, refreshHistory]);

  // ── TTS + visual alerts ───────────────────────────────────────────────────
  useEffect(() => {
    if (!stream) return;
    void navigator.mediaDevices.enumerateDevices().then(devices => setCameras(devices.filter(d => d.kind === "videoinput"))).catch(() => {});
  }, [stream]);

  // ── Critical event video recording (shared function for all triggers) ─────
  const { recordingStatus, statusMessage: recordingMessage } = useVideoRecorder(
    stream,
    latestEvent,
    micStream,
    monitoringPaused,
    upsertEvent
  );

  // ── Test email alert ──────────────────────────────────────────────────────
  const handleSendTestPhoton = useCallback(async () => {
    setPhotonTestStatus("sending");
    setPhotonError("");
    try {
      const response = await fetch("/api/photon/test", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not send the test message.");
      setPhotonTestStatus("sent");
    } catch (error) {
      setPhotonTestStatus("error");
      setPhotonError(error instanceof Error ? error.message : "Could not send the test message.");
    }
  }, []);

  const handleSendTestEmail = useCallback(async () => {
    setEmailTestStatus("sending");
    try {
      const res = await fetch("/api/email-alerts/test", { method: "POST" });
      setEmailTestStatus(res.ok ? "sent" : "error");
    } catch {
      setEmailTestStatus("error");
    }
    setTimeout(() => setEmailTestStatus("idle"), 4000);
  }, []);

  // ── Demo triggers ─────────────────────────────────────────────────────────
  const handleTriggerDemo = useCallback(() => {
    injectDemoEvent("possible_fall", "urgent");
  }, [injectDemoEvent]);

  // ── Check service status on mount ─────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 12000);
    setPatientError("");
    fetch("/api/residents", { signal: controller.signal })
      .then(async (r) => { if (r.status === 401) { if (!disposed) setAuthRequired(true); return null; } if (!r.ok) throw new Error("The patient database is temporarily unreachable. Please retry in a moment."); return r.json(); })
      .then((d) => {
        if (disposed || !d) return;
        const active: ResidentProfile[] = Array.isArray(d.residents) ? d.residents.filter((r: ResidentProfile) => r.active !== false) : [];
        if (active.length) {
          setResidents(active);
          setSelectedResidentId(id => active.some(resident => resident.id === id) ? id : active[0].id);
          setMongoConnected(d.mongoConnected === true);
        } else {
          setPatientError("No active patients are assigned to this account. Ask an administrator to check patient access.");
        }
      })
      .catch((error: unknown) => { if (!disposed) { setMongoConnected(false); setPatientError(controller.signal.aborted ? "Loading took too long. Please retry; the server may still be starting." : error instanceof Error ? error.message : "Could not reach the server. Please retry."); } })
      .finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [patientLoadAttempt]);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => {
        setMongoConnected(d.mongoConnected === true);
        setEmailConfigured(d.emailConfigured === true);
        setPhotonConfigured(d.photonConfigured === true);
      })
      .catch(() => {
        setEmailConfigured(false);
      });
  }, []);

  // ── Acknowledge event ─────────────────────────────────────────────────────
  const handleAcknowledge = useCallback(async (eventId: string) => {
    const response = await fetch(`/api/events/${eventId}/acknowledge`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledgedBy: "Demo Caregiver" }),
      });
    if (!response.ok) throw new Error("Could not acknowledge event");
    upsertEvent(await response.json());
    setAnalyticsRefreshKey((k) => k + 1);
  }, [upsertEvent]);

  // ── Add caregiver note ────────────────────────────────────────────────────
  const handleAddNote = useCallback(
    async (eventId: string, residentId: string, note: string) => {
      const response = await fetch(`/api/events/${eventId}/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ residentId, note, createdBy: "Demo Caregiver" }),
        });
      if (!response.ok) throw new Error("Could not save note");
    },
    []
  );

  const severityGlow: Record<string, string> = {
    stable: "",
    watch: "shadow-yellow-500/20 shadow-lg",
    assist: "shadow-orange-500/30 shadow-xl",
    urgent: "shadow-red-500/40 shadow-2xl",
  };

  if (authRequired) return <SignIn />;
  if (!selectedResident) return <main className="flex min-h-screen items-center justify-center bg-sensara-cream p-6"><section className="w-full max-w-md rounded-xl border border-sensara-border bg-white p-6 shadow-sm">
    <h1 className="text-xl font-semibold text-sensara-forest-900">Sensara</h1>
    <p className="mt-3 text-sm text-sensara-forest-800" role={patientError ? "alert" : "status"}>{patientError || "Connecting to patient records…"}</p>
    {patientError ? <button className="mt-4 rounded-lg bg-sensara-forest-700 px-4 py-2 text-sm font-semibold text-white" onClick={() => { setPatientError(""); setPatientLoadAttempt(n => n + 1); }}>Retry connection</button> : <p className="mt-3 text-xs text-sensara-warm-600">The first visit after starting the development server can take longer while it compiles.</p>}
  </section></main>;
  return (
    <div className="min-h-screen bg-sensara-cream text-sensara-forest-900 flex flex-col">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <header className="border-b border-sensara-forest-900 bg-sensara-forest-800 sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">

          {/* Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <Image
              src="/sensara-logo.png"
              alt="Sensara"
              width={80}
              height={80}
              priority
              className="w-20 h-20 object-contain"
            />
            <div>
              <h1 className="text-white font-bold text-lg leading-tight italic" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>Sensara</h1>
              <p className="text-sensara-forest-300 text-xs tracking-wide uppercase">Visual Safety Monitoring</p>
            </div>
          </div>

          {/* Main tab switcher */}
          <div className="flex items-center gap-1 bg-sensara-forest-900/60 border border-sensara-forest-700 rounded-xl p-1 mx-auto">
            <MainTabButton
              active={mainTab === "multi-feed"}
              onClick={() => { setIsPaused(true); setMainTab("multi-feed"); }}
              label="Multi-Feed Demo"
              desc="4-room command center"
            />
            <MainTabButton
              active={mainTab === "live-camera"}
              onClick={() => { setMonitoringConsent(true); setIsPaused(false); setMainTab("live-camera"); }}
              label="Live Camera Demo"
              desc="Opens camera + monitoring"
            />
          </div>

          {/* Pause control */}
          <div className="flex items-center gap-2 flex-wrap justify-end ml-auto">
            {controlsPaused && (
              <span className="text-xs font-bold text-yellow-300 bg-yellow-900/80 border border-yellow-600 rounded-lg px-3 py-1.5 animate-pulse">
                ⏸ PAUSED
              </span>
            )}
            <button
              onClick={toggleMonitoring} aria-describedby="monitoring-consent"
              className={`text-xs rounded-lg px-3 py-1.5 transition-colors border font-medium ${
                startAvailable
                  ? "bg-sensara-forest-600 hover:bg-sensara-forest-500 text-white border-sensara-forest-500"
                  : "bg-yellow-700/70 hover:bg-yellow-600/80 text-yellow-100 border-yellow-600"
              }`}
            >
              {startAvailable ? "▶ " : "⏸ "}{controlLabel}
            </button>
          </div>
        </div>

      </header>

      {/* ── Toasts (always on top, fixed position) ────────────────────────── */}
      {recordingMessage && (
        <div className={`fixed top-20 right-4 z-50 rounded-xl px-4 py-2 text-sm shadow-xl border animate-fade-in flex items-center gap-2
          ${recordingStatus === "capturing" ? "bg-red-900 text-red-200 border-red-700" :
            recordingStatus === "uploading" ? "bg-blue-900 text-blue-200 border-blue-700" :
            recordingStatus === "saved" ? "bg-green-900 text-green-200 border-green-700" :
            recordingStatus === "s3-disabled" ? "bg-yellow-900/80 text-yellow-200 border-yellow-700" :
            "bg-red-900 text-red-200 border-red-700"}`}
        >
          {recordingStatus === "capturing" && <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />}
          {recordingStatus === "uploading" && <span className="w-4 h-4 border-2 border-blue-400/30 border-t-blue-300 rounded-full animate-spin" />}
          {recordingMessage}
        </div>
      )}

      {/* ── Tab content ───────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-[1400px] mx-auto w-full px-4 py-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sensara-border bg-white p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold" role="status">{mainTab === "multi-feed" ? (demo.anyRunning ? `${demo.runningFeedIds.length} of ${demoFeedIds.length} feeds running` : "Demo paused — play a feed below or start all four") : (isPaused ? "Camera monitoring paused" : "Monitoring enabled")}</p>
            <p id="monitoring-consent" className="mt-1 text-xs text-sensara-warm-600">{mainTab === "live-camera" ? "Opening Live Camera starts" : "Starting authorizes"} {mainTab === "live-camera" ? `camera monitoring of ${selectedResident.name}` : "the selected fictional feeds"}, 15-second incident recordings and configured alerts. {mainTab === "multi-feed" && "Start demo plays all four; each feed has its own Play/Pause. "}Audio playback has its own control on the right.</p>
          </div>
          {mainTab === "multi-feed" && demo.anyRunning && !demo.allRunning && <button onClick={demo.pauseAll} className="rounded-lg border border-sensara-border px-4 py-2 text-sm font-semibold hover:bg-sensara-warm-100">Pause all</button>}
          <button onClick={toggleMonitoring} aria-describedby="monitoring-consent" className="rounded-lg bg-sensara-forest-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sensara-forest-600">{controlLabel}</button>
        </div>
        {sessionError && <p role="alert" className="mb-3 text-red-700">{sessionError} <button className="underline" onClick={restartCamera}>Reconnect monitoring</button></p>}
        {mainTab === "live-camera" && <label className="mb-3 block text-sm">Camera <select value={cameraId} onChange={e => setCameraId(e.target.value)}><option value="">Default camera</option>{cameras.map(c => <option key={c.deviceId} value={c.deviceId}>{c.label || "Camera"}</option>)}</select></label>}
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
        {/* ── TAB 1: Multi-Feed Demo ──────────────────────────────────────── */}
        <div className={mainTab === "multi-feed" ? "" : "hidden"}>
          <MultiFeedDemo onAlertsChange={setFeedAlerts} events={persistedEvents} residents={residents} runningFeedIds={demo.runningFeedIds} onToggleFeed={demo.toggleFeed} />
        </div>

        {/* ── TAB 2: Live Camera Demo ─────────────────────────────────────── */}
        {/* Keep refs mounted while the hook controls camera acquisition and cleanup. */}
        <div className={mainTab === "live-camera" ? "" : "hidden"}>
          <div>
            {/* Live Camera controls */}
            <div className="bg-white border border-sensara-border rounded-xl px-4 py-2.5 mb-4 flex items-center gap-2 flex-wrap">
              <StatusPill
                active={poseStatus === "running" && !isPaused}
                label={isPaused ? "Paused" : poseStatus === "running" ? "Camera Live" : "Camera " + poseStatus}
                color={isPaused ? "yellow" : poseStatus === "running" ? "green" : poseStatus === "loading" ? "yellow" : "red"}
              />
              <EmailStatusBadge configured={emailConfigured} testStatus={emailTestStatus} />
              <button
                onClick={handleTriggerDemo}
                disabled={poseStatus !== "running" || isPaused}
                className="text-xs bg-red-700 hover:bg-red-600 disabled:bg-sensara-warm-200 disabled:text-sensara-warm-500 text-white border border-red-600 rounded-lg px-3 py-1.5 transition-colors"
              >
                ⚡ Trigger Critical Event
              </button>
              {emailConfigured && (
                <button
                  onClick={handleSendTestEmail}
                  disabled={emailTestStatus === "sending"}
                  className="text-xs bg-blue-700/80 hover:bg-blue-600/90 disabled:opacity-60 text-white border border-blue-600 rounded-lg px-3 py-1.5 transition-colors"
                >
                  {emailTestStatus === "sending" ? "Sending…" : emailTestStatus === "sent" ? "✓ Sent" : emailTestStatus === "error" ? "✗ Failed" : "📧 Test Email"}
                </button>
              )}
            </div>

            {/* Two-column live camera layout */}
            <div className="min-w-0">

              {/* Left column: Camera + Analytics + AI + Audio */}
              <div className="flex flex-col gap-5">

                {/* Camera feed */}
                <div className={`rounded-xl overflow-hidden transition-shadow duration-500 ${severityGlow[classification.severity]}`}>
                  <div className="flex items-center justify-between px-1 mb-2">
                    <h2 className="text-sensara-forest-800 text-sm font-semibold flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      Live Feed — {selectedResident.room}
                    </h2>
                    <span className="text-xs text-gray-600">MediaPipe Pose Landmarker</span>
                  </div>
                  <PoseCamera
                    videoRef={videoRef}
                    canvasRef={canvasRef}
                    landmarks={landmarks}
                    status={poseStatus}
                    errorMessage={errorMessage}
                    safeZone={safeZone}
                    severity={classification.severity}
                    observationAvailable={signals.visible && poseStatus === "running" && !monitoringPaused}
                    onRetry={restartCamera}
                    editMode={safeZoneEditMode}
                    onSafeZoneChange={handleSafeZoneChange}
                    insideSafeZone={signals.insideSafeZone}
                  />
                </div>

                <p className="text-xs text-sensara-warm-700">Keep your shoulders and hands in view for gestures, and your hips in view for posture/fall tracking. Test without applying neck pressure or deliberately falling.</p>
                {/* Safe zone controls */}
                <div className="flex items-center gap-3 flex-wrap bg-white border border-sensara-border rounded-lg px-3 py-2">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={safeZoneEditMode}
                      onChange={(e) => setSafeZoneEditMode(e.target.checked)}
                      className="w-3.5 h-3.5 accent-green-500"
                    />
                    <span className="text-xs">
                      <span className="text-sensara-forest-600 font-medium">Edit Safe Zone</span>
                    </span>
                  </label>
                  <button
                    onClick={resetSafeZone}
                    className="text-xs bg-sensara-warm-100 hover:bg-sensara-warm-200 text-sensara-forest-700 border border-sensara-border rounded px-2 py-0.5 transition-colors"
                  >
                    Reset Safe Zone
                  </button>
                  <span className="text-[10px] text-sensara-warm-500 ml-auto hidden sm:block">
                    Drag edges to resize · Uses torso center · Persists across refreshes
                  </span>
                </div>

                {/* Vision Debug: choking detection state */}
                <div className="bg-white border border-sensara-border rounded-lg px-3 py-2 shadow-sm">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] text-sensara-warm-600 font-medium uppercase tracking-wider">Observed hand gesture</span>
                    <span className="text-[10px] text-sensara-warm-400">Either hand held near neck: {POSE_POLICY.gestureHold}s to urgent</span>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <DebugPill
                      label="Left Hand"
                      active={signals.leftHandNearThroat ?? false}
                      activeColor="text-red-600"
                      activeLabel="Near throat"
                      inactiveLabel="Away"
                    />
                    <DebugPill
                      label="Right Hand"
                      active={signals.rightHandNearThroat ?? false}
                      activeColor="text-orange-600"
                      activeLabel="Near throat"
                      inactiveLabel="Away"
                    />
                    <DebugPill
                      label="Both Hands"
                      active={signals.bothHandsNearThroat ?? false}
                      activeColor="text-yellow-600"
                      activeLabel="Both near"
                      inactiveLabel="No"
                    />
                    <div className="flex items-center gap-1.5 ml-auto">
                      <span className="text-[10px] text-sensara-warm-500">Timer:</span>
                      <div className="w-24 h-2 bg-sensara-warm-200 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-200"
                          style={{
                            width: `${Math.min(100, ((signals.handsNearThroatSeconds ?? 0) / POSE_POLICY.gestureHold) * 100)}%`,
                            background: (signals.handsNearThroatSeconds ?? 0) >= POSE_POLICY.gestureHold
                              ? "#ef4444"
                              : (signals.handsNearThroatSeconds ?? 0) > 0
                              ? "#f97316"
                              : "#d4c9b0",
                          }}
                        />
                      </div>
                      <span className="text-[10px] text-sensara-forest-700 w-8 text-right">
                        {((signals.handsNearThroatSeconds ?? 0)).toFixed(1)}s
                      </span>
                    </div>
                  </div>
                </div>

                {/* Analytics + AI + Audio Monitor */}
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  <AnalyticsCard mongoConnected={mongoConnected} refreshTrigger={analyticsRefreshKey} />
                  <AIAssistant key={selectedResident.id} resident={selectedResident} classification={classification} />
                  <AudioMonitor
                    sessionId={sessionId}
                    resident={selectedResident}
                    isPaused={isPaused || mainTab !== "live-camera"}
                    onEventSaved={upsertEvent}
                    onMicStream={setMicStream}
                  />
                </div>
              </div>


            </div>
          </div>
        </div>
          <Administration residents={residents} onSaved={() => window.location.reload()} />
        </div>
        <aside aria-label="Alerts and notifications" className="min-w-0 space-y-4 lg:sticky lg:top-32 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto lg:pr-1">
        {mainTab === "live-camera" && (
                <ResidentCard
                  resident={selectedResident}
                  classification={classification}
                  signals={signals}
                  monitoringAvailable={poseStatus === "running" && !monitoringPaused}
                  residents={residents}
                  onSelectResident={setSelectedResidentId}
                />
        )}
        <IncidentCenter onEvents={setPersistedEvents} />
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-sensara-border bg-white px-4 py-3 text-xs">
          <span>Photon iMessage: {photonConfigured ? "Configured · see notification outcomes" : "Not configured"}</span>
          {photonConfigured && (
            <button
              onClick={handleSendTestPhoton}
              disabled={photonTestStatus === "sending"}
              className="rounded-lg bg-sensara-forest-700 px-3 py-1.5 text-white disabled:opacity-60"
            >
              {photonTestStatus === "sending" ? "Sending…" : "Test iMessage"}
            </button>
          )}
          <span role="status" className={photonTestStatus === "error" ? "text-red-700" : "text-sensara-forest-700"}>
            {photonTestStatus === "sent" ? "Test message sent to Photon." : photonError}
          </span>
        </div>

          {mainTab === "multi-feed" ? <DemoAlertPanel alerts={feedAlerts} events={persistedEvents} isPaused={!demo.anyRunning} /> : (
              <div className="flex flex-col gap-4">


                <div className="bg-white rounded-xl border border-sensara-border flex flex-col shadow-sm">
                  <div className="flex border-b border-sensara-divider">
                    <TabButton
                      active={activeTab === "monitor"}
                      onClick={() => { setActiveTab("monitor"); void refreshHistory(); }}
                      label="Live Events"
                    />
                    <TabButton
                      active={activeTab === "history"}
                      onClick={() => setActiveTab("history")}
                      label="History"
                    />
                  </div>
                  <div className="p-3">
                    {persistenceError && <p role="alert" className="text-red-700 text-xs mb-2">{persistenceError}</p>}
                    {activeTab === "monitor" && (
                      <EventTimeline
                        events={timeline.filter((e) => e.eventType !== "normal")}
                        onAcknowledge={handleAcknowledge}
                        onAddNote={handleAddNote}
                      />
                    )}
                    {activeTab === "history" && (
                      <ResidentHistoryPanel residentId={selectedResident.id} />
                    )}
                  </div>
                </div>
              </div>
          )}
        </aside>
        </div>
      </main>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="border-t border-sensara-border py-3 px-4 text-center text-xs text-sensara-warm-600">
        Sensara — Prototype · Hackathon Demo · Not for clinical use ·{" "}
        <span className="text-sensara-warm-500">Mock resident data only</span>
      </footer>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function MainTabButton({
  active,
  onClick,
  label,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  desc?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center px-4 py-2 rounded-lg transition-all text-xs font-semibold ${
        active
          ? "bg-sensara-forest-500 text-white shadow-lg shadow-sensara-forest-900/40"
          : "text-sensara-forest-200 hover:text-white hover:bg-sensara-forest-700/60"
      }`}
    >
      {label}
      {desc && (
        <span className={`text-[10px] font-normal mt-0.5 ${active ? "text-sensara-forest-100" : "text-sensara-forest-400"}`}>
          {desc}
        </span>
      )}
    </button>
  );
}

function StatusPill({
  active,
  label,
  color,
}: {
  active: boolean;
  label: string;
  color: "green" | "yellow" | "red";
}) {
  const dotColor =
    color === "green" ? "bg-green-400" : color === "yellow" ? "bg-yellow-400" : "bg-red-400";
  const textColor =
    color === "green" ? "text-green-300" : color === "yellow" ? "text-yellow-300" : "text-red-300";

  return (
    <div className="flex items-center gap-1.5 bg-sensara-forest-900/80 rounded-full px-2.5 py-1 border border-sensara-forest-700">
      <div className={`w-1.5 h-1.5 rounded-full ${dotColor} ${active ? "animate-pulse" : ""}`} />
      <span className={`text-xs ${textColor}`}>{label}</span>
    </div>
  );
}

function EmailStatusBadge({
  configured,
  testStatus,
}: {
  configured: boolean;
  testStatus: "idle" | "sending" | "sent" | "error";
}) {
  const isError = testStatus === "error";
  const dot = isError ? "bg-red-400 animate-pulse" : configured ? "bg-green-400" : "bg-yellow-400";
  const text = isError ? "text-red-300" : configured ? "text-green-300" : "text-yellow-300";
  const label = isError ? "Email Error" : configured ? "Email Alerts Ready" : "Email Not Configured";

  return (
    <div className="flex items-center gap-1.5 bg-sensara-forest-900/80 rounded-full px-2.5 py-1 border border-sensara-forest-700">
      <div className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className={`text-xs ${text}`}>📧 {label}</span>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "text-sensara-forest-700 border-b-2 border-sensara-forest-700"
          : "text-sensara-warm-600 hover:text-sensara-forest-800"
      }`}
    >
      {label}
    </button>
  );
}

function DebugPill({
  label,
  active,
  activeColor,
  activeLabel,
  inactiveLabel,
}: {
  label: string;
  active: boolean;
  activeColor: string;
  activeLabel: string;
  inactiveLabel: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? "bg-red-500 animate-pulse" : "bg-sensara-warm-300"}`} />
      <span className="text-[10px] text-sensara-warm-600">{label}:</span>
      <span className={`text-[10px] font-medium ${active ? activeColor : "text-sensara-warm-500"}`}>
        {active ? activeLabel : inactiveLabel}
      </span>
    </div>
  );
}

// ─── Resident history panel ────────────────────────────────────────────────────
function ResidentHistoryPanel({ residentId }: { residentId: string }) {
  const [history, setHistory] = useState<{
    totalEventsToday: number;
    urgentEvents: number;
    assistEvents: number;
    watchEvents: number;
    totalVideoClips: number;
    latestVideoClipAt: string | null;
    mostCommonEventType: string | null;
    lastEventAt: string | null;
    recentEvents: SafetyEvent[];
    videoClips: VideoClip[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewingClip, setViewingClip] = useState<{ id: string; label: string } | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [clipLoading, setClipLoading] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setHistory(null);
    fetch(`/api/residents/${residentId}/history`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!controller.signal.aborted) setHistory(d); })
      .catch(() => { if (!controller.signal.aborted) setHistory(null); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [residentId]);

  const handleViewClip = async (clipId: string, label: string) => {
    setViewingClip({ id: clipId, label });
    setClipUrl(null);
    setClipError(null);
    setClipLoading(true);
    try {
      const res = await fetch(`/api/video-clips/${clipId}/playback-url`);
      const data = await res.json();
      if (data.s3Disabled) {
        setClipError("S3 not configured — demo clips are not playable in this deployment.");
      } else if (data.playbackUrl) {
        setClipUrl(data.playbackUrl);
      } else {
        setClipError(data.error ?? "Could not load clip.");
      }
    } catch {
      setClipError("Failed to load clip URL.");
    } finally {
      setClipLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-12 bg-sensara-warm-100 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (!history) {
    return <p className="text-gray-500 text-sm text-center py-4">History unavailable</p>;
  }

  const EVENT_LABELS: Record<string, string> = {
    fall_risk: "Fall Risk",
    possible_fall: "Possible Fall",
    immobility: "Immobility",
    wandering: "Wandering",
    unsafe_posture: "Unsafe Posture",
    seizure_like_motion: "Seizure-Like Motion",
    out_of_frame: "Out of Frame",
    audio_distress: "Audio Distress",
    possible_distress_sound: "Distress Sound",
    possible_fall_sound: "Fall Sound",
    possible_choking: "Possible Choking",
  };

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-sensara-warm-100 rounded-lg p-2">
          <p className="text-gray-500">Today</p>
          <p className="text-sensara-forest-900 font-bold text-lg">{history.totalEventsToday}</p>
          <p className="text-gray-500">events</p>
        </div>
        <div className="bg-red-50 rounded-lg p-2 border border-red-200">
          <p className="text-gray-500">Urgent (all time)</p>
          <p className="text-red-700 font-bold text-lg">{history.urgentEvents}</p>
        </div>
        <div className="bg-orange-50 rounded-lg p-2 border border-orange-200">
          <p className="text-gray-500">Assist</p>
          <p className="text-orange-700 font-bold text-lg">{history.assistEvents}</p>
        </div>
        <div className="bg-blue-50 rounded-lg p-2 border border-blue-200">
          <p className="text-gray-500">Video Clips</p>
          <p className="text-blue-700 font-bold text-lg">{history.totalVideoClips ?? 0}</p>
        </div>
      </div>

      {history.mostCommonEventType && (
        <p className="text-xs text-sensara-warm-700">
          Most common:{" "}
          <span className="text-white font-medium">
            {EVENT_LABELS[history.mostCommonEventType] ?? history.mostCommonEventType}
          </span>
        </p>
      )}

      {/* Video clips list */}
      {(history.videoClips ?? []).length > 0 && (
        <div>
          <p className="text-[11px] text-gray-500 font-medium mb-1.5">📹 Video Clips</p>
          <div className="space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar">
            {(history.videoClips ?? []).map((clip) => (
              <div
                key={clip._id}
                className="flex items-center gap-2 text-xs bg-blue-950/20 border border-blue-900/30 rounded-lg p-2"
              >
                <span className="text-blue-400 shrink-0">📹</span>
                <div className="flex-1 min-w-0">
                  <span className="text-blue-200">{EVENT_LABELS[clip.eventType] ?? clip.eventType}</span>
                  <span className="text-gray-600 ml-1.5">
                    {new Date(clip.createdAt).toLocaleDateString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="text-gray-600 ml-1">· {clip.durationSeconds}s</span>
                  {clip.hasAudioTrack && <span className="text-purple-400 ml-1 text-[9px]">🎙</span>}
                </div>
                {clip._id && (
                  <button
                    onClick={() => handleViewClip(clip._id!, EVENT_LABELS[clip.eventType] ?? clip.eventType)}
                    className="shrink-0 text-[10px] bg-blue-800/50 hover:bg-blue-700/60 text-blue-200 rounded px-2 py-0.5 transition-colors"
                  >
                    View
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Clip viewer modal */}
      {viewingClip && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setViewingClip(null)}
        >
          <div
            className="relative bg-gray-900 border border-gray-700 rounded-xl p-4 max-w-2xl w-full mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold text-sm">📹 {viewingClip.label}</h3>
              <button onClick={() => setViewingClip(null)} className="text-gray-500 hover:text-white text-lg">✕</button>
            </div>
            {clipLoading && (
              <div className="flex items-center justify-center h-32 text-sensara-warm-700 text-sm">
                <span className="w-5 h-5 border-2 border-gray-600 border-t-white rounded-full animate-spin mr-2" />
                Loading clip…
              </div>
            )}
            {clipError && (
              <div className="bg-red-950/50 border border-red-800/60 rounded-lg p-4 text-red-700 text-sm">{clipError}</div>
            )}
            {clipUrl && (
              <video src={clipUrl} controls autoPlay className="w-full rounded-lg bg-black max-h-96" />
            )}
            <p className="text-[10px] text-gray-600 mt-2 text-center">
              ⚠️ Prototype only. Not for clinical use. All data is mock/demo data.
            </p>
          </div>
        </div>
      )}

      {/* Recent events list */}
      <div>
        <p className="text-[11px] text-gray-500 font-medium mb-1.5">Recent Events</p>
        <div className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar">
          {(history.recentEvents ?? []).length === 0 && (
            <p className="text-gray-600 text-xs text-center py-4">No events recorded</p>
          )}
          {(history.recentEvents ?? []).map((e) => (
            <div
              key={e._id}
              className="flex items-start gap-2 text-xs text-sensara-warm-700 bg-gray-700/30 rounded-lg p-2"
            >
              <span
                className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                  e.severity === "urgent"
                    ? "bg-red-400"
                    : e.severity === "assist"
                    ? "bg-orange-400"
                    : e.severity === "watch"
                    ? "bg-yellow-400"
                    : "bg-green-400"
                }`}
              />
              <div className="flex-1 min-w-0">
                <span className="text-white">{EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                {e.source === "audio_monitor" && <span className="ml-1 text-purple-400 text-[10px]">🎙️</span>}
                {e.source === "multi_feed_demo" && <span className="ml-1 text-blue-400 text-[10px]">[demo]</span>}
                {e.hasVideoClip && <span className="ml-1 text-blue-400 text-[10px]">📹</span>}
                <span className="text-gray-600 ml-1.5">
                  {new Date(e.createdAt).toLocaleDateString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
