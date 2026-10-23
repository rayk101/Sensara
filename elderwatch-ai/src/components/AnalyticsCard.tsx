"use client";

import { useEffect, useState, useCallback } from "react";
import type { DashboardAnalytics } from "@/lib/types";

interface AnalyticsCardProps {
  mongoConnected: boolean;
  refreshTrigger?: number;
}

const EVENT_LABELS: Record<string, string> = {
  fall_risk: "Fall Risk",
  possible_fall: "Possible Fall",
  immobility: "Immobility",
  wandering: "Wandering",
  unsafe_posture: "Unsafe Posture",
  out_of_frame: "Out of Frame",
  normal: "Normal",
};

export default function AnalyticsCard({ mongoConnected, refreshTrigger }: AnalyticsCardProps) {
  const [analytics, setAnalytics] = useState<DashboardAnalytics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAnalytics = useCallback(async () => {
    try {
      const res = await fetch("/api/analytics");
      if (res.ok) {
        const data = await res.json();
        setAnalytics(data);
      }
    } catch {
      // Non-fatal
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics, refreshTrigger]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const id = setInterval(fetchAnalytics, 30_000);
    return () => clearInterval(id);
  }, [fetchAnalytics]);

  return (
    <div className="bg-white rounded-xl border border-sensara-border p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sensara-forest-900 font-semibold text-sm flex items-center gap-2">
          <span>📊</span> Analytics (last 24h)
        </h3>
        <div className="flex items-center gap-1.5">
          <div
            className={`w-2 h-2 rounded-full ${mongoConnected ? "bg-green-500" : "bg-yellow-500"}`}
          />
          <span className="text-[10px] text-sensara-warm-600">
            {mongoConnected ? "MongoDB" : "Demo Mode"}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-sensara-warm-100 rounded-lg h-14 animate-pulse" />
          ))}
        </div>
      ) : analytics ? (
        <div className="grid grid-cols-2 gap-2">
          <StatTile
            label="Total Events"
            value={analytics.totalEventsLast24h}
            color="text-sensara-forest-700"
          />
          <StatTile
            label="Critical"
            value={analytics.urgentEventsLast24h}
            color="text-red-600"
            highlight={analytics.urgentEventsLast24h > 0}
          />
          <StatTile
            label="Assist"
            value={analytics.assistEventsLast24h}
            color="text-orange-600"
          />
          <StatTile
            label="Top Event"
            value={
              analytics.mostFrequentEventType
                ? EVENT_LABELS[analytics.mostFrequentEventType] ?? analytics.mostFrequentEventType
                : "—"
            }
            color="text-sensara-forest-600"
            small
          />
          {analytics.residentWithMostAlerts && (
            <div className="col-span-2 bg-sensara-warm-100 border border-sensara-divider rounded-lg p-2.5">
              <p className="text-[10px] text-sensara-warm-600 uppercase tracking-wide">Most Alerts</p>
              <p className="text-sensara-forest-900 text-sm font-semibold">
                {analytics.residentWithMostAlerts.name}
              </p>
              <p className="text-sensara-warm-700 text-xs">
                {analytics.residentWithMostAlerts.room} ·{" "}
                {analytics.residentWithMostAlerts.count} event
                {analytics.residentWithMostAlerts.count !== 1 ? "s" : ""}
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sensara-warm-500 text-sm text-center py-4">Analytics unavailable</p>
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  color,
  highlight = false,
  small = false,
}: {
  label: string;
  value: string | number;
  color: string;
  highlight?: boolean;
  small?: boolean;
}) {
  return (
    <div
      className={`bg-sensara-warm-100 border border-sensara-divider rounded-lg p-2.5 ${highlight ? "ring-1 ring-red-400" : ""}`}
    >
      <p className="text-[10px] text-sensara-warm-600 uppercase tracking-wide">{label}</p>
      <p className={`font-bold mt-0.5 ${color} ${small ? "text-sm" : "text-xl"}`}>{value}</p>
    </div>
  );
}
