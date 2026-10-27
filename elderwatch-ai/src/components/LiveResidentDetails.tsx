"use client";

import { useEffect, useState } from "react";
import { residentDisplayName } from "@/lib/residentDisplay";
import type { ResidentProfile } from "@/lib/types";

export default function LiveResidentDetails({ resident }: { resident: ResidentProfile }) {
  const [alertsToday, setAlertsToday] = useState<number | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/residents/${encodeURIComponent(resident.id)}/history`, { signal: controller.signal });
        if (!response.ok) throw new Error("History unavailable");
        const history = await response.json();
        if (typeof history.totalEventsToday !== "number") throw new Error("History unavailable");
        if (!controller.signal.aborted) { setAlertsToday(history.totalEventsToday); setHistoryUnavailable(false); }
      } catch {
        if (!controller.signal.aborted) { setAlertsToday(null); setHistoryUnavailable(true); }
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [resident.id]);

  return <section className="live-resident-details" aria-label={`Live camera details for ${residentDisplayName(resident.id, resident.name)}`}>
    <h2>Live Camera Feed</h2>
    <span className="risk-badge">{resident.fallRisk} risk</span>
    <dl className="live-resident-stats">
      <div><dt>Mobility</dt><dd>{resident.mobility || "Not recorded"}</dd></div>
      <div><dt>Alerts today</dt><dd aria-live="polite" title={historyUnavailable ? "Unable to load today's alerts" : undefined}>{historyUnavailable ? "Unavailable" : alertsToday ?? "—"}</dd></div>
    </dl>
    <div className="live-resident-conditions">
      <h3>Conditions</h3>
      <div>{resident.conditions.length ? resident.conditions.map(condition => <span className="risk-badge" key={condition}>{condition}</span>) : <span className="risk-badge">None recorded</span>}</div>
    </div>
    <div className="live-care-note"><h3>Care note</h3><p>{resident.careNotes || "No care note recorded."}</p></div>
  </section>;
}
