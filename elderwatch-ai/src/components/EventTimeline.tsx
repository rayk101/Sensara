"use client";

import { useState, useEffect } from "react";
import SafetyBadge from "./SafetyBadge";
import type { SafetyEvent } from "@/lib/types";

interface EventTimelineProps {
  events: SafetyEvent[];
  onResolve?: (eventId: string, reason: string) => Promise<void>;
  onDismiss?: (eventId: string, reason: string) => Promise<void>;
  onAcknowledge: (eventId: string) => Promise<void>;
  onAddNote: (eventId: string, residentId: string, note: string) => Promise<void>;
}

const EVENT_LABELS: Record<string, string> = {
  fall_risk: "Fall Risk",
  possible_fall: "Possible Fall",
  immobility: "Immobility",
  wandering: "Wandering",
  unsafe_posture: "Unsafe Posture",
  seizure_like_motion: "Possible Seizure-Like Movement",
  out_of_frame: "Out of Frame",
  audio_distress: "Audio Distress",
  possible_distress_sound: "Possible Distress Sound",
  possible_fall_sound: "Possible Fall Sound",
  possible_choking: "Possible Choking",
  normal: "Normal",
};

const EVENT_ICONS: Record<string, string> = {
  fall_risk: "⚠️",
  possible_fall: "🚨",
  immobility: "🛑",
  wandering: "🚶",
  unsafe_posture: "↗️",
  seizure_like_motion: "⚡",
  out_of_frame: "👁️",
  audio_distress: "🎙️",
  possible_distress_sound: "🔊",
  possible_fall_sound: "💥",
  possible_choking: "🫁",
  normal: "✅",
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

// ─── Video clip viewer modal ──────────────────────────────────────────────────
function VideoClipModal({
  clipId,
  eventLabel,
  onClose,
}: {
  clipId: string;
  eventLabel: string;
  onClose: () => void;
}) {
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/video-clips/${clipId}/playback-url`)
      .then((r) => r.json())
      .then((d) => {
        if (d.s3Disabled) {
          setError("S3 not configured in this deployment — demo clips are not playable.");
        } else if (d.playbackUrl) {
          setPlaybackUrl(d.playbackUrl);
        } else {
          setError(d.error ?? "Could not load clip.");
        }
      })
      .catch(() => setError("Failed to load clip URL."))
      .finally(() => setLoading(false));
  }, [clipId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative bg-white border border-sensara-border rounded-xl p-4 max-w-2xl w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sensara-forest-900 font-semibold text-sm">
            📹 Video Clip — {eventLabel}
          </h3>
          <button
            onClick={onClose}
            className="text-sensara-warm-500 hover:text-sensara-forest-900 text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center h-40 text-sensara-warm-500 text-sm">
            <span className="w-5 h-5 border-2 border-sensara-border border-t-sensara-forest-700 rounded-full animate-spin mr-2" />
            Loading clip…
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-300 rounded-lg p-4 text-red-700 text-sm">
            {error}
          </div>
        )}

        {playbackUrl && (
          <video
            src={playbackUrl}
            controls
            autoPlay
            className="w-full rounded-lg bg-black max-h-96"
          />
        )}

        <p className="text-[10px] text-sensara-warm-400 mt-2 text-center">
          ⚠️ Prototype only. Not for clinical use. All data is mock/demo data.
        </p>
      </div>
    </div>
  );
}

export default function EventTimeline({ events, onAcknowledge, onAddNote, onResolve, onDismiss }: EventTimelineProps) {
  const [closureReason, setClosureReason] = useState<Record<string, string>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState<Record<string, string>>({});
  const [viewingClip, setViewingClip] = useState<{ clipId: string; label: string } | null>(null);

  const deduplicated = events.filter(
    (e, i, arr) => arr.findIndex((x) => x._id === e._id) === i
  );

  return (
    <>
      {actionMessage && <p role="status" className="text-xs mb-2">{actionMessage}</p>}
      <div className="flex flex-col gap-2 max-h-[420px] overflow-y-auto pr-1 custom-scrollbar">
        {deduplicated.length === 0 && (
          <p className="text-sensara-warm-500 text-sm text-center py-6">
            No saved events yet
          </p>
        )}

        {deduplicated.map((event) => {
          const isExpanded = expandedId === event._id;
          const isNonStable = event.severity !== "stable";

          return (
            <div
              key={event._id}
              className={`rounded-lg border transition-all duration-200 animate-fade-in
                ${event.severity === "urgent" ? "border-red-300 bg-red-50" :
                  event.severity === "assist" ? "border-orange-300 bg-orange-50" :
                  event.severity === "watch" ? "border-yellow-300 bg-yellow-50" :
                  "border-sensara-divider bg-sensara-warm-100/60"}`}
            >
              {/* Event summary row */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : (event._id ?? null))}
                className="w-full text-left px-3 py-2.5 flex items-start gap-3"
              >
                <span className="text-base mt-0.5 shrink-0">{EVENT_ICONS[event.eventType] ?? "•"}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <SafetyBadge severity={event.severity} size="sm" />
                    <span className="text-sensara-forest-900 text-sm font-medium">
                      {EVENT_LABELS[event.eventType] ?? event.eventType}
                    </span>
                    {event.acknowledged && (
                      <span className="text-[10px] bg-green-100 text-green-700 border border-green-300 rounded-full px-1.5 py-0.5">
                        {event.status === "resolved" ? "Resolved" : event.status === "dismissed" ? "Dismissed" : "✓ Acknowledged"}
                      </span>
                    )}
                    {event.source === "audio_monitor" && (
                      <span className="text-[10px] bg-purple-100 text-purple-700 border border-purple-300 rounded-full px-1.5 py-0.5">
                        🎙️ Audio
                      </span>
                    )}
                    {event.hasVideoClip && (
                      <span className="text-[10px] bg-sensara-forest-100 text-sensara-forest-700 border border-sensara-forest-200 rounded-full px-1.5 py-0.5">
                        📹 Video Clip
                      </span>
                    )}
                  </div>
                  <p className="text-sensara-warm-700 text-xs mt-0.5 truncate">{event.reason}</p>
                </div>
                <div className="text-right shrink-0 text-[10px] text-sensara-warm-600">
                  <div>{formatTimestamp(event.createdAt)}</div>
                  <div className="text-sensara-warm-400">{formatRelative(event.createdAt)}</div>
                </div>
              </button>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="px-3 pb-3 border-t border-sensara-divider pt-2 space-y-2 animate-fade-in">
                  <p className="text-sensara-forest-800 text-xs">{event.reason}</p>

                  {event.audioTranscript && (
                    <div className="bg-purple-50 border border-purple-200 rounded-lg px-2.5 py-1.5">
                      <p className="text-[9px] text-purple-600 mb-0.5">Transcript</p>
                      <p className="text-xs text-purple-800 italic">&ldquo;{event.audioTranscript}&rdquo;</p>
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-1 text-[10px] font-mono text-sensara-warm-600">
                    <span>{event.confidence > 0 ? <>Heuristic score: <b className="text-sensara-forest-900">{Math.round(event.confidence * 100)}/100</b></> : "Movement rule — no calibrated probability"}</span>
                    <span>Posture: <b className="text-sensara-forest-900">{Math.round(event.signals?.postureAngle ?? 0)}°</b></span>
                    <span>Still: <b className="text-sensara-forest-900">{Math.round(event.signals?.secondsStill ?? 0)}s</b></span>
                  </div>

                  {/* View Clip button */}
                  {event.hasVideoClip && event.videoClipId && (
                    <button
                      onClick={() =>
                        setViewingClip({
                          clipId: event.videoClipId!,
                          label: event.videoClip?.fileName ?? EVENT_LABELS[event.eventType] ?? event.eventType,
                        })
                      }
                      className="w-full text-xs bg-sensara-forest-700 hover:bg-sensara-forest-600 text-white border border-sensara-forest-500 rounded-lg py-1.5 transition-colors"
                    >
                      📹 View Clip{event.videoClip?.fileName ? ` · ${event.videoClip.fileName}` : ""}
                    </button>
                  )}

                  {event.workflow && <div className="rounded border p-2 text-xs" aria-label="Integration progress">
                    <p>Video: {event.workflow.video.status.replace(/_/g, " ")}{event.workflow.video.error ? ` — ${event.workflow.video.error}` : ""}</p>
                    <p>Voice generation: {event.workflow.voice.status.replace(/_/g, " ")}{event.workflow.voice.error ? ` — ${event.workflow.voice.error}` : ""}</p>
                    <p>Messaging intent: {event.workflow.messaging.status === "configuration_failed" ? "No authorized recipient configured" : event.workflow.messaging.status.replace(/_/g, " ")}. Recipient outcomes are listed above.</p>
                  </div>}
                  <p className="text-xs">Response: {event.status ?? (event.acknowledged ? "acknowledged" : "open")}</p>
                  {!["resolved", "dismissed"].includes(event.status ?? "") && (onResolve || onDismiss) && <div className="space-y-2">
                    <label className="block text-xs">Closure reason<input className="mt-1 block w-full rounded border p-2" maxLength={2000} value={closureReason[event._id!] ?? ""} onChange={e => setClosureReason(prev => ({ ...prev, [event._id!]: e.target.value }))} /></label>
                    <div className="flex gap-2">
                      {event.acknowledged && onResolve && <button disabled={!closureReason[event._id!]?.trim() || pendingId === event._id} className="rounded border px-2 py-1 text-xs disabled:opacity-40" onClick={async () => { setPendingId(event._id!); try { await onResolve(event._id!, closureReason[event._id!]); } catch (e) { setActionMessage(e instanceof Error ? e.message : "Resolution failed"); } finally { setPendingId(null); } }}>Resolve</button>}
                      {onDismiss && <button disabled={!closureReason[event._id!]?.trim() || pendingId === event._id} className="rounded border px-2 py-1 text-xs disabled:opacity-40" onClick={async () => { setPendingId(event._id!); try { await onDismiss(event._id!, closureReason[event._id!]); } catch (e) { setActionMessage(e instanceof Error ? e.message : "Dismissal failed"); } finally { setPendingId(null); } }}>Dismiss</button>}
                    </div>
                  </div>}
                  {/* Acknowledge button */}
                  {isNonStable && !event.acknowledged && !["resolved", "dismissed"].includes(event.status ?? "") && event._id && (
                    <button
                      disabled={pendingId === event._id}
                      onClick={async () => {
                        setPendingId(event._id!);
                        setActionMessage(null);
                        try { await onAcknowledge(event._id!); }
                        catch { setActionMessage("Could not acknowledge alert. Please try again."); }
                        finally { setPendingId(null); }
                      }}
                      className="w-full text-xs bg-sensara-warm-100 hover:bg-sensara-warm-200 text-sensara-forest-800 border border-sensara-border rounded-lg py-1.5 transition-colors"
                    >
                      ✓ Acknowledge Alert
                    </button>
                  )}

                  {/* Caregiver note input */}
                  {event._id && (
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={noteText[event._id] ?? ""}
                        onChange={(e) =>
                          setNoteText((prev) => ({ ...prev, [event._id!]: e.target.value }))
                        }
                        placeholder="Add caregiver note…"
                        className="flex-1 text-xs bg-white text-sensara-forest-900 rounded-lg px-2 py-1.5 border border-sensara-border focus:outline-none focus:ring-1 focus:ring-sensara-forest-500"
                      />
                      <button
                        disabled={pendingId === event._id}
                        onClick={async () => {
                          const note = noteText[event._id!]?.trim();
                          if (note && event._id) {
                            setPendingId(event._id);
                            setActionMessage(null);
                            try {
                              await onAddNote(event._id, event.residentId, note);
                              setNoteText(prev => ({ ...prev, [event._id!]: "" }));
                              setActionMessage("Note saved.");
                            } catch { setActionMessage("Could not save note. Please try again."); }
                            finally { setPendingId(null); }
                          }
                        }}
                        className="text-xs bg-sensara-forest-700 hover:bg-sensara-forest-600 text-white rounded-lg px-2.5 py-1.5 transition-colors"
                      >
                        Save
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {viewingClip && (
        <VideoClipModal
          clipId={viewingClip.clipId}
          eventLabel={viewingClip.label}
          onClose={() => setViewingClip(null)}
        />
      )}
    </>
  );
}
