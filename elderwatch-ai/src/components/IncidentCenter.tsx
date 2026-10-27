"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SafetyEvent } from "@/lib/types";
import EventTimeline, { type IncidentNotice } from "./EventTimeline";
import type { MonitoringActivity } from "@/lib/monitoringActivity";
export default function IncidentCenter({ onEvents, showHistory = false, residentId, title, voiceEnabled, eventIds, activeEventIds, activities, activeActivityIds }: {
  onEvents?: (events: SafetyEvent[]) => void; showHistory?: boolean; residentId?: string; title?: string; voiceEnabled?: boolean;
  /** Undefined shows saved history; an empty list starts a fresh monitoring view. */
  eventIds?: string[];
  activeEventIds?: string[];
  activities?: MonitoringActivity[];
  activeActivityIds?: string[];
}) {
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  const [notices, setNotices] = useState<IncidentNotice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [localAudioEnabled, setAudioEnabled] = useState(false);
  const audioEnabled = voiceEnabled ?? localAudioEnabled;
  const [voiceStatus, setVoiceStatus] = useState("Voice alerts ready");
  const [retry, setRetry] = useState(0);
  const manualPlayRef = useRef<(() => void) | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seen = useRef(new Set<string>());
  const processing = useRef(false);
  const refreshState = useRef({ version: 0 });
  const eventQuery = eventIds === undefined ? "" : `&ids=${eventIds.join(",")}`;
  const awaitingIncidents = eventIds?.length === 0;
  const refresh = useCallback(async () => {
    const version = ++refreshState.current.version;
    if (awaitingIncidents) { setEvents([]); setNotices([]); setError(""); setLoaded(true); return; }
    try {
      const [er, nr] = await Promise.all([fetch(`/api/events?limit=100${eventQuery}`), fetch("/api/notifications")]);
      if (!er.ok || !nr.ok) throw new Error("Incident history is unavailable. Monitoring results may not be saved.");
      const [e, n] = await Promise.all([er.json(), nr.json()]);
      if (version !== refreshState.current.version) return;
      setEvents(e.events); onEvents?.(e.events); setNotices(n.notifications); setError(""); setLoaded(true);
    } catch (e) { if (version === refreshState.current.version) setError(e instanceof Error ? e.message : "Connection unavailable"); }
  }, [onEvents, eventQuery, awaitingIncidents]);
  useEffect(() => {
    const state = refreshState.current;
    void refresh();
    if (awaitingIncidents) return;
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { clearInterval(timer); state.version++; };
  }, [refresh, awaitingIncidents]);
  const displayedEvents = events.filter(event => (!residentId || event.residentId === residentId)
    && (eventIds === undefined || !!event._id && eventIds.includes(event._id)));
  const openEvents = displayedEvents.filter(event => event.severity !== "stable" && !["resolved", "dismissed"].includes(event.status ?? ""));
  const visibleActivities = activities?.filter(activity => !residentId || activity.residentId === residentId);
  const activeEvents = openEvents.filter(event => activeEventIds === undefined || !!event._id && activeEventIds.includes(event._id));
  const activeActivities = visibleActivities?.filter(activity => activity.severity !== "stable" && activeActivityIds?.includes(activity.id)
    && !["resolved", "dismissed"].includes((displayedEvents.find(event => event._id === activity.event?._id) ?? activity.event)?.status ?? ""));
  const openCount = activeActivities ? new Set(activeActivities.map(activity => activity.event?._id ?? activity.id)).size : activeEvents.length;
  const voiceEvents = activities ? activeEvents.filter(event => activeActivities?.some(activity => activity.event?._id === event._id)) : activeEvents;
  const eventKey = voiceEvents.map(e => `${e._id}:${e.severity}:${e.acknowledged}:${e.status}`).join("|");
  useEffect(() => {
    if (!audioEnabled || processing.current) return;
    const event = voiceEvents.find(e => e._id && e.severity === "urgent" && e.workflow?.voice.status !== "not_requested" && !e.acknowledged && !["resolved", "dismissed"].includes(e.status ?? "") && !seen.current.has(e._id));
    if (!event?._id) return;
    const id = event._id;
    let disposed = false;
    const controller = new AbortController();
    processing.current = true;
    const deviceId = localStorage.getItem("sensara-device-id") ?? crypto.randomUUID();
    localStorage.setItem("sensara-device-id", deviceId);
    const report = (status: string) => fetch(`/api/events/${id}/voice`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Sensara-Device": deviceId }, body: JSON.stringify({ status }) }).catch(() => {});
    const play = async () => {
      const run = async () => {
        // A browser lock prevents two tabs on this workstation from talking at once.
        if (localStorage.getItem(`sensara-spoken:${id}`)) { seen.current.add(id); return; }
        setVoiceStatus(`Generating speech for ${event.residentName}…`);
        let response: Response;
        for (let attempt = 0; ; attempt++) {
          response = await fetch(`/api/events/${id}/voice`, { method: "POST", headers: { "X-Sensara-Device": deviceId }, signal: controller.signal });
          if (response.status !== 425 || attempt >= 5) break;
          await new Promise(resolve => setTimeout(resolve, 3000));
          if (disposed) return;
        }
        if (!response.ok) throw new Error((await response.json()).error ?? "Speech generation failed");
        const url = URL.createObjectURL(await response.blob());
        if (disposed) { URL.revokeObjectURL(url); return; }
        const audio = audioRef.current ?? new Audio(); audioRef.current = audio; audio.src = url;
        let finished = false;
        try {
          await new Promise<void>((resolve, reject) => {
            audio.onended = () => { finished = true; void report("played"); localStorage.setItem(`sensara-spoken:${id}`, "completed"); setVoiceStatus("Playback completed"); resolve(); };
            audio.onerror = () => { finished = true; void report("playback_failed"); reject(new Error("Audio playback failed")); };
            const attemptPlay = () => { void audio.play().then(() => { manualPlayRef.current = null; void report("playing"); setVoiceStatus(`Playing alert for ${event.residentName}`); }).catch(() => { void report("blocked"); setVoiceStatus("Audio blocked. Select Play blocked alert."); manualPlayRef.current = attemptPlay; }); };
            attemptPlay();
            controller.signal.addEventListener("abort", () => { if (finished) return; audio.pause(); void report("interrupted"); reject(new Error("Playback interrupted")); }, { once: true });
          });
        } finally { manualPlayRef.current = null; audio.onended = null; audio.onerror = null; URL.revokeObjectURL(url); }
      };
      try {
        if (navigator.locks) await navigator.locks.request("sensara-voice", { signal: controller.signal }, run); else throw new Error("This browser cannot coordinate audio tabs. Use a supported browser.");
      } catch (e) { if (!disposed) setVoiceStatus(e instanceof Error ? e.message : "Voice alert failed"); }
      finally { seen.current.add(id); processing.current = false; if (!disposed) setRetry(v => v + 1); }
    };
    void play();
    return () => { disposed = true; controller.abort(); };
    // Queue identity is stable between polling refreshes; retry advances it after playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioEnabled, eventKey, retry]);
  const action = async (id: string, path: string, body: object = {}) => { const r = await fetch(`/api/events/${id}/${path}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error((await r.json()).error ?? "Action failed"); await refresh(); };
  const retryNotice = async (notice: IncidentNotice) => {
    if (notice.status === "unknown" && !window.confirm("The provider may already have sent this message. Retry anyway?")) return;
    const response = await fetch(`/api/notifications/${notice.id}/retry`, { method: "POST" });
    if (!response.ok) throw new Error((await response.json()).error ?? "Retry failed");
    await refresh();
  };
  return <section className="attention-panel">
    <header className="attention-header">
      <h2>{title ?? (showHistory ? "Incident history" : "Needs attention")}</h2>
      <div className="attention-header-actions">
        {voiceEnabled === undefined && <button className={`audio-toggle${audioEnabled ? " audio-toggle--enabled" : ""}`} aria-label={audioEnabled ? "Disable audio alerts" : "Enable audio alerts"}
          aria-pressed={audioEnabled} title={audioEnabled ? "Disable audio alerts" : "Enable audio alerts"}
          onClick={() => { audioRef.current ??= new Audio(); setAudioEnabled(value => !value); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M11 4 6 8H3v8h3l5 4V4Z" strokeLinejoin="round" />
            {audioEnabled ? <><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" strokeLinecap="round" /></> : <path d="m16 9 5 6m0-6-5 6" strokeLinecap="round" />}
          </svg>
        </button>}
        {!showHistory && <span className="open-count" aria-live="polite">{activities !== undefined || activeEventIds?.length === 0 || awaitingIncidents ? `${openCount} open` : error ? "Unavailable" : !loaded ? "Loading…" : `${openCount} open`}</span>}
      </div>
    </header>
    {error && <p role="alert" className="panel-message">{error}</p>}
    {audioEnabled && <div className="voice-status" role="status"><span>{voiceStatus}</span>
      <button onClick={() => { if (manualPlayRef.current) { manualPlayRef.current(); return; } seen.current.clear(); setRetry(value => value + 1); }}>{voiceStatus.startsWith("Audio blocked") ? "Play alert" : "Retry voice"}</button>
    </div>}
    {(loaded || activities !== undefined) && <EventTimeline events={showHistory || activeEventIds !== undefined || activities !== undefined ? displayedEvents : openEvents}
      activities={visibleActivities} activeActivityIds={activeActivityIds} notifications={notices} onRetryNotification={retryNotice}
      emptyMessage={showHistory ? "No saved incidents" : "No incidents need attention"}
      onAcknowledge={id => action(id, "acknowledge")} onResolve={(id, reason) => action(id, "resolve", { reason })}
      onDismiss={(id, reason) => action(id, "dismiss", { reason })}
      onAddNote={async (eventId, residentId, note) => {
        const response = await fetch(`/api/events/${eventId}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ residentId, note }) });
        if (!response.ok) throw new Error("Could not save note");
      }} />}
  </section>;
}
