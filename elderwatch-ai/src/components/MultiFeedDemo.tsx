"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import DemoVideoTile, { type DemoFeedConfig, type DemoFeedStatus } from "./DemoVideoTile";
import FacilityAlertPanel, { type FeedAlert } from "./FacilityAlertPanel";

import { DEMO_SCENARIOS } from "@/lib/demoScenarios";
import type { ResidentProfile, SafetyEvent } from "@/lib/types";
interface FeedState extends DemoFeedStatus {
  alertSince: number;
}

const defaultFeedState: FeedState = {
  severity: "stable",
  eventType: "normal",
  reason: "No concerning activity detected",
  confidence: 0.95,
  alertSince: 0,
};

export default function MultiFeedDemo({ isPaused = false, residents, events, onAlertsChange }: { isPaused?: boolean; residents: ResidentProfile[]; events: SafetyEvent[]; onAlertsChange: (alerts: FeedAlert[]) => void }) {
  const DEMO_FEEDS: DemoFeedConfig[] = useMemo(() => DEMO_SCENARIOS.flatMap(scenario => {
    const patient = residents.find(r => r.id === scenario.residentId && r.active !== false);
    return patient ? [{ ...scenario, resident: patient.name, room: patient.room }] : [];
  }), [residents]);
  const [feedStates, setFeedStates] = useState<Record<string, FeedState>>({});

  const handleStatusChange = useCallback((feedId: string, status: DemoFeedStatus) => {
    setFeedStates(prev => {
      const prevState = prev[feedId];
      const prevSeverity = prevState?.severity ?? "stable";

      // Only reset alertSince when severity transitions from stable → non-stable
      const alertSince =
        status.severity !== "stable" && prevSeverity === "stable"
          ? Date.now()
          : (prevState?.alertSince ?? Date.now());

      return { ...prev, [feedId]: { ...status, alertSince } };
    });
  }, []);

  const alerts: FeedAlert[] = useMemo(() => DEMO_FEEDS.map(feed => {
    const state = feedStates[feed.id] ?? defaultFeedState;
    return {
      feedId: feed.id,
      room: feed.room,
      resident: feed.resident,
      residentId: feed.residentId,
      severity: state.severity,
      eventType: state.eventType,
      reason: state.reason,
      confidence: state.confidence,
      alertSince: state.alertSince,
    };
  }), [DEMO_FEEDS, feedStates]);
  useEffect(() => { onAlertsChange(alerts); }, [alerts, onAlertsChange]);

  return (
    <div className="flex flex-col gap-5">
      {DEMO_FEEDS.length < 4 && <p role="alert" className="text-sm text-amber-800">Some scenario patients are unavailable or not assigned to this account.</p>}
      {/* Two-column video grid; alerts are rendered in the dashboard sidebar. */}
      <div className="min-w-0">
        {/* 2×2 video grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {DEMO_FEEDS.map(feed => (
            <DemoVideoTile
              key={feed.id}
              config={feed}
              activeUrgent={events.some(e => e.residentId === feed.residentId && e.severity === "urgent" && !["resolved", "dismissed"].includes(e.status ?? ""))}
              isPaused={isPaused}
              onStatusChange={handleStatusChange}
            />
          ))}
        </div>


      </div>
    </div>
  );
}

export function DemoAlertPanel({ alerts, events, isPaused }: { alerts: FeedAlert[]; events: SafetyEvent[]; isPaused: boolean }) {
  const saveEvent = async (alert: FeedAlert) => {
    if (alert.severity === "stable") return;
    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "manual",
        sourceEventId: `panel:${alert.feedId}:${alert.alertSince}`,
        detectedAt: new Date().toISOString(),
        residentId: alert.residentId,
        residentName: alert.resident,
        room: alert.room,
        severity: alert.severity,
        eventType: alert.eventType,
        confidence: alert.confidence,
        reason: alert.reason,
        acknowledged: false,
      }),
    });
    if (!response.ok) throw new Error("Could not save alert");
  };

  const handleSaveAll = async () => {
    const active = alerts.filter(a => a.severity !== "stable");
    await Promise.all(active.map(saveEvent));
  };

  return (
        <FacilityAlertPanel
          alerts={isPaused ? [] : alerts}
          isPaused={isPaused}
          onMarkCare={async feedId => {
            const feed = alerts.find(f => f.feedId === feedId);
            const active = events.filter(e => e.residentId === feed?.residentId && !["resolved", "dismissed"].includes(e.status ?? ""));
            if (!active.length) throw new Error("No saved incident yet");
            await Promise.all(active.map(async e => { const r = await fetch(`/api/events/${e._id}/acknowledge`, { method: "PATCH" }); if (!r.ok) throw new Error("Acknowledgment failed"); }));
          }}
          onSaveToHistory={saveEvent}
          onSaveAll={handleSaveAll}
        />
  );
}
