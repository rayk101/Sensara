"use client";
import { useEffect, useState } from "react";
export function useMonitoringSession(residentId: string | undefined, enabled: boolean, source: "live_camera" | "multi_feed_demo", deviceId: string) {
  const [session, setSession] = useState<{ id: string; residentId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSession(null); setError(null);
    if (!residentId || !enabled) return;
    let disposed = false;
    const id = crypto.randomUUID();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => { void fetch(`/api/monitoring-sessions/${id}`, { method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "ended" }) }).catch(() => {}); };
    const start = async () => {
      try {
        const response = await fetch("/api/monitoring-sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, residentId, source, deviceId, consent: true }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Monitoring session could not start");
        if (disposed) { stop(); return; }
        setSession({ id: result.id, residentId });
        heartbeat = setInterval(() => {
          void fetch(`/api/monitoring-sessions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "active" }) }).then(async r => {
            const updated = await r.json();
            if (!r.ok || updated.status !== "active") throw new Error();
            if (!disposed) setError(null);
          }).catch(() => { if (!disposed) { setError("Monitoring session disconnected. Stop and restart monitoring to reconnect."); setSession(null); } });
        }, 20_000);
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "Monitoring unavailable"); }
    };
    void start();
    window.addEventListener("pagehide", stop);
    return () => { disposed = true; clearInterval(heartbeat); window.removeEventListener("pagehide", stop); stop(); };
  }, [residentId, enabled, source, deviceId]);
  return { sessionId: enabled && session?.residentId === residentId ? session.id : null, sessionError: error };
}
