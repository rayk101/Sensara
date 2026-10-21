"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SafetyEvent } from "@/lib/types";
import EventTimeline from "./EventTimeline";
interface Notice { id: string; eventId: string; residentId: string; staffId: string; channel: string; status: string; error: string | null }
export default function IncidentCenter() {
  const [events, setEvents] = useState<SafetyEvent[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [error, setError] = useState("");
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("Audio alerts off");
  const [retry, setRetry] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seen = useRef(new Set<string>());
  const processing = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const [er, nr] = await Promise.all([fetch("/api/events?limit=100"), fetch("/api/notifications")]);
      if (!er.ok || !nr.ok) throw new Error("Incident history is unavailable. Monitoring results may not be saved.");
      const [e, n] = await Promise.all([er.json(), nr.json()]); setEvents(e.events); setNotices(n.notifications); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Connection unavailable"); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 3000); return () => clearInterval(timer); }, [refresh]);
  const urgent = events.filter(e => e.severity === "urgent" && !["resolved", "dismissed"].includes(e.status ?? ""));
  useEffect(() => {
    if (!audioEnabled || processing.current) return;
    const event = events.find(e => e._id && e.severity === "urgent" && !e.acknowledged && !["resolved", "dismissed"].includes(e.status ?? "") && !seen.current.has(e._id));
    if (!event?._id) return;
    const id = event._id;
    let disposed = false;
    const controller = new AbortController();
    processing.current = true;
    const report = (status: string) => fetch(`/api/events/${id}/voice`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }).catch(() => {});
    const play = async () => {
      const run = async () => {
        // A browser lock prevents two tabs on this workstation from talking at once.
        if (localStorage.getItem(`sensara-spoken:${id}`)) { seen.current.add(id); return; }
        setVoiceStatus(`Generating speech for ${event.residentName}…`);
        const response = await fetch(`/api/events/${id}/voice`, { method: "POST", signal: controller.signal });
        if (!response.ok) throw new Error((await response.json()).error ?? "Speech generation failed");
        const url = URL.createObjectURL(await response.blob());
        if (disposed) { URL.revokeObjectURL(url); return; }
        const audio = audioRef.current ?? new Audio(); audioRef.current = audio; audio.src = url;
        try {
          await new Promise<void>((resolve, reject) => {
            audio.onended = () => { void report("played"); localStorage.setItem(`sensara-spoken:${id}`, "completed"); setVoiceStatus("Playback completed"); resolve(); };
            audio.onerror = () => { void report("playback_failed"); reject(new Error("Audio playback failed")); };
            void audio.play().then(() => setVoiceStatus(`Playing alert for ${event.residentName}`)).catch(() => { void report("blocked"); reject(new Error("Audio blocked. Use Retry voice to play manually.")); });
            controller.signal.addEventListener("abort", () => { audio.pause(); reject(new Error("Playback interrupted")); }, { once: true });
          });
        } finally { audio.onended = null; audio.onerror = null; URL.revokeObjectURL(url); }
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
  }, [audioEnabled, events.map(e => `${e._id}:${e.acknowledged}:${e.status}`).join("|"), retry]);
  const action = async (id: string, path: string, body: object = {}) => { const r = await fetch(`/api/events/${id}/${path}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error((await r.json()).error ?? "Action failed"); await refresh(); };
  return <section className="my-4 rounded-xl border border-sensara-border bg-white p-4">
    <div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold">Saved incidents</h2><span className={urgent.length ? "font-bold text-red-700" : "text-sm"}>{urgent.length ? `${urgent.length} unresolved urgent incident(s)` : "No unresolved urgent incidents"}</span>
      <button className="rounded border px-3 py-1 text-xs" onClick={() => { audioRef.current ??= new Audio(); setAudioEnabled(v => !v); }}>{audioEnabled ? "Disable audio alerts" : "Enable Audio Alerts"}</button>
      <button className="rounded border px-3 py-1 text-xs" onClick={() => { seen.current.clear(); setAudioEnabled(true); setRetry(v => v + 1); }}>Retry voice</button><span role="status" className="text-xs">{voiceStatus}</span>
    </div>
    {error && <p role="alert" className="my-2 font-semibold text-red-700">{error}</p>}
    <details className="my-3"><summary className="cursor-pointer text-sm">Notification outcomes ({notices.length})</summary>
      {notices.map(n => <div key={n.id} className="my-1 text-xs">{n.channel} · {n.staffId} · {n.status}{n.error ? ` — ${n.error}` : ""}{["failed", "unknown"].includes(n.status) && n.channel !== "voice" && <button className="ml-2 underline" onClick={async () => { if (n.status === "unknown" && !window.confirm("The provider may already have sent this message. Retry anyway?")) return; const r = await fetch(`/api/notifications/${n.id}/retry`, { method: "POST" }); if (!r.ok) setError((await r.json()).error); await refresh(); }}>Retry</button>}</div>)}
    </details>
    <EventTimeline events={events} onAcknowledge={id => action(id, "acknowledge")} onResolve={(id, reason) => action(id, "resolve", { reason })} onDismiss={(id, reason) => action(id, "dismiss", { reason })} onAddNote={async (eventId, residentId, note) => { const r = await fetch(`/api/events/${eventId}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ residentId, note }) }); if (!r.ok) throw new Error("Could not save note"); }} />
  </section>;
}
