"use client";

import { useState, useEffect, useRef } from "react";
import SafetyBadge from "./SafetyBadge";

export interface FeedAlert {
  feedId: string;
  room: string;
  resident: string;
  residentId: string;
  severity: "stable" | "watch" | "assist" | "urgent";
  eventType: string;
  reason: string;
  confidence: number;
  alertSince: number;
}

interface FacilityAlertPanelProps {
  alerts: FeedAlert[];
  isPaused?: boolean;
  onMarkCare?: (feedId: string) => Promise<void>;
  onSaveToHistory?: (alert: FeedAlert) => Promise<void>;
  onSaveAll?: () => Promise<void>;
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
  possible_fall_sound: "Fall Sound",
};

const SEVERITY_ORDER: Record<string, number> = { urgent: 0, assist: 1, watch: 2, stable: 3 };

function useTickingClock(intervalMs = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

function formatWaitTime(alertSince: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - alertSince) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

export default function FacilityAlertPanel({
  alerts,
  isPaused = false,
  onMarkCare,
  onSaveToHistory,
  onSaveAll,
}: FacilityAlertPanelProps) {
  useTickingClock();

  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [markedIds, setMarkedIds] = useState<Set<string>>(new Set());
  const [savingAll, setSavingAll] = useState(false);
  const [savedAllMsg, setSavedAllMsg] = useState<string | null>(null);

  // Clear saved/marked state when alerts change identity
  const prevAlertIdsRef = useRef<string>("");
  useEffect(() => {
    const key = alerts.map(a => a.feedId + a.severity).join(",");
    if (key !== prevAlertIdsRef.current) {
      prevAlertIdsRef.current = key;
      // Clear saved status for feeds that went back to stable
      const stableIds = alerts.filter(a => a.severity === "stable").map(a => a.feedId);
      if (stableIds.length > 0) {
        setSavedIds(prev => { const s = new Set(prev); stableIds.forEach(id => s.delete(id)); return s; });
        setMarkedIds(prev => { const s = new Set(prev); stableIds.forEach(id => s.delete(id)); return s; });
      }
    }
  }, [alerts]);

  const activeAlerts = alerts
    .filter(a => a.severity !== "stable")
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const handleSave = async (alert: FeedAlert) => {
    if (savingIds.has(alert.feedId) || savedIds.has(alert.feedId)) return;
    setSavingIds(prev => new Set(prev).add(alert.feedId));
    try {
      await onSaveToHistory?.(alert);
      setSavedIds(prev => new Set(prev).add(alert.feedId));
    } catch {
      setSavedAllMsg("Could not save alert. Please try again.");
    } finally {
      setSavingIds(prev => { const s = new Set(prev); s.delete(alert.feedId); return s; });
    }
  };

  const handleSaveAll = async () => {
    if (savingAll || activeAlerts.length === 0) return;
    setSavingAll(true);
    try {
      await onSaveAll?.();
      setSavedIds(new Set(activeAlerts.map(a => a.feedId)));
      const count = activeAlerts.length;
      setSavedAllMsg(`${count} alert${count !== 1 ? "s" : ""} saved to history`);
      setTimeout(() => setSavedAllMsg(null), 3500);
    } catch {
      setSavedAllMsg("Save failed");
      setTimeout(() => setSavedAllMsg(null), 3000);
    } finally {
      setSavingAll(false);
    }
  };

  const handleMarkCare = async (feedId: string) => {
    try { await onMarkCare?.(feedId); setMarkedIds(prev => new Set(prev).add(feedId)); }
    catch { setSavedAllMsg("Acknowledgment was not saved. Use Saved incidents to retry."); }
  };

  const urgentCount = activeAlerts.filter(a => a.severity === "urgent").length;

  return (
    <div className="bg-white border border-sensara-border rounded-xl flex flex-col min-h-0 xl:h-full shadow-sm">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-sensara-divider shrink-0">
        <div>
          <h3 className="text-sensara-forest-900 font-semibold text-sm">Facility Alert Panel</h3>
          <p className="text-sensara-warm-600 text-[10px] mt-0.5">{isPaused ? "Monitoring paused" : "Measured video observations"}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5 bg-sensara-warm-100 border border-sensara-divider rounded-full px-2.5 py-1">
            <div className={`w-1.5 h-1.5 rounded-full ${urgentCount > 0 ? "bg-red-500 animate-pulse" : activeAlerts.length > 0 ? "bg-yellow-500 animate-pulse" : "bg-green-500"}`} />
            <span className="text-[10px] text-sensara-forest-700">
              {isPaused ? "Paused" : activeAlerts.length === 0 ? "No current feed alerts" : `${activeAlerts.length} alert${activeAlerts.length !== 1 ? "s" : ""}`}
            </span>
          </div>
          {activeAlerts.length > 0 && (
            <button
              onClick={handleSaveAll}
              disabled={savingAll || activeAlerts.every(a => savedIds.has(a.feedId))}
              className="text-[10px] bg-sensara-forest-700 hover:bg-sensara-forest-600 disabled:opacity-40 text-white border border-sensara-forest-500 rounded-lg px-2.5 py-1 transition-colors whitespace-nowrap"
            >
              {savingAll ? "Saving…" : "Save All Alerts"}
            </button>
          )}
          {savedAllMsg && (
            <span className="text-[10px] text-green-600">{savedAllMsg}</span>
          )}
        </div>
      </div>

      {/* Alert list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar min-h-[200px]">
        {activeAlerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="w-10 h-10 rounded-full bg-green-100 border border-green-300 flex items-center justify-center mb-3">
              <span className="text-green-600 text-lg">✓</span>
            </div>
            <p className="text-sensara-forest-700 text-sm font-medium">{isPaused ? "Start the demo to monitor feeds" : "No current detector alerts"}</p>
            <p className="text-sensara-warm-500 text-[10px] mt-1">Review saved incidents above. Monitoring may be paused.</p>
          </div>
        ) : (
          activeAlerts.map(alert => {
            const isUrgent = alert.severity === "urgent";
            const isAssist = alert.severity === "assist";
            const borderClass = isUrgent
              ? "bg-red-50 border-red-300"
              : isAssist
              ? "bg-orange-50 border-orange-300"
              : "bg-yellow-50 border-yellow-300";
            const dotClass = isUrgent ? "bg-red-500" : isAssist ? "bg-orange-500" : "bg-yellow-500";
            const labelColor = isUrgent ? "#dc2626" : isAssist ? "#ea580c" : "#ca8a04";
            const isCared = markedIds.has(alert.feedId);
            const isSaved = savedIds.has(alert.feedId);
            const isSavingThis = savingIds.has(alert.feedId);

            return (
              <div
                key={alert.feedId}
                className={`rounded-xl border p-3 transition-all duration-300 ${borderClass} ${isCared ? "opacity-60" : ""}`}
              >
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full shrink-0 mt-0.5 ${dotClass} ${isUrgent ? "animate-pulse" : ""}`} />
                    <div>
                      <p className="text-sensara-forest-900 text-xs font-semibold leading-tight">{alert.resident}</p>
                      <p className="text-sensara-warm-600 text-[10px]">{alert.room}</p>
                    </div>
                  </div>
                  <SafetyBadge severity={alert.severity} size="sm" pulse={isUrgent} />
                </div>

                <div className="mb-2">
                  <p className="text-[11px] font-semibold" style={{ color: labelColor }}>
                    {EVENT_LABELS[alert.eventType] ?? alert.eventType}
                  </p>
                  <p className="text-sensara-warm-700 text-[10px] mt-0.5 leading-relaxed line-clamp-2">{alert.reason}</p>
                </div>

                <div className="flex items-center justify-between gap-1">
                  <div className="flex items-center gap-1.5 text-[9px] text-sensara-warm-500 flex-wrap">
                    <span>Active {formatWaitTime(alert.alertSince)}</span>
                    <span>·</span>
                    <span>Movement rule · not a medical probability</span>
                    {isCared && <span className="text-green-600 font-medium">✓ In care</span>}
                    {isSaved && <span className="text-sensara-forest-600 font-medium">✓ Saved</span>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleMarkCare(alert.feedId)}
                      disabled={isCared}
                      className="text-[9px] bg-green-100 hover:bg-green-200 disabled:opacity-40 text-green-700 border border-green-300 rounded px-1.5 py-0.5 transition-colors whitespace-nowrap"
                    >
                      {isCared ? "In Care" : "Mark Care"}
                    </button>
                    <button
                      onClick={() => handleSave(alert)}
                      disabled={isSavingThis || isSaved}
                      className="text-[9px] bg-sensara-forest-700 hover:bg-sensara-forest-600 disabled:opacity-40 text-white border border-sensara-forest-500 rounded px-1.5 py-0.5 transition-colors"
                    >
                      {isSavingThis ? "…" : isSaved ? "Saved" : "Save"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="px-4 py-2 border-t border-sensara-divider shrink-0">
        <p className="text-[9px] text-sensara-warm-400 text-center">
          Recorded demo footage · Pose-based heuristics · Human review required
        </p>
      </div>
    </div>
  );
}
