"use client";

import { useState, useCallback } from "react";
import DemoVideoTile, { type DemoFeedConfig, type DemoFeedStatus } from "./DemoVideoTile";
import FacilityAlertPanel, { type FeedAlert } from "./FacilityAlertPanel";

const DEMO_FEEDS: DemoFeedConfig[] = [
  {
    id: "feed1",
    room: "Room 204",
    resident: "Eleanor Brooks",
    residentId: "resident_001",
    risk: "High fall risk",
    videoFile: "fall-demo.mp4",
  },
  {
    id: "feed2",
    room: "Room 118",
    resident: "Robert Hayes",
    residentId: "resident_002",
    risk: "Post-surgery mobility",
    videoFile: "stable-demo.mp4",
  },
  {
    id: "feed3",
    room: "Room 312",
    resident: "Margaret Chen",
    residentId: "resident_003",
    risk: "Wandering / Memory care",
    videoFile: "wandering-demo.mp4",
  },
  {
    id: "feed4",
    room: "Lounge Area",
    resident: "Daniel Price",
    residentId: "demo_resident_004",
    risk: "Medium risk",
    videoFile: "choking-demo.mp4",
  },
];

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

export default function MultiFeedDemo({ isPaused = false }: { isPaused?: boolean }) {
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

  const alerts: FeedAlert[] = DEMO_FEEDS.map(feed => {
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
      alertSince: state.alertSince || Date.now(),
    };
  });

  const saveEvent = async (alert: FeedAlert) => {
    if (alert.severity === "stable") return;
    const response = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "multi_feed_demo",
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
    <div className="flex flex-col gap-5">
      {/* Main layout: 2×2 grid + alert panel */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-5 items-start">
        {/* 2×2 video grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {DEMO_FEEDS.map(feed => (
            <DemoVideoTile
              key={feed.id}
              config={feed}
              isPaused={isPaused}
              onStatusChange={handleStatusChange}
            />
          ))}
        </div>

        {/* Facility alert panel */}
        <FacilityAlertPanel
          alerts={alerts}
          onSaveToHistory={saveEvent}
          onSaveAll={handleSaveAll}
        />
      </div>
    </div>
  );
}
