"use client";

import { useState, useEffect } from "react";
import { residentDisplayName } from "@/lib/residentDisplay";
import type { SafetyEvent } from "@/lib/types";

export interface IncidentNotice {
  id: string; eventId: string; residentId: string; staffId: string; channel: string; status: string; error: string | null;
}

interface EventTimelineProps {
  notifications?: IncidentNotice[];
  onRetryNotification?: (notice: IncidentNotice) => Promise<void>;
  emptyMessage?: string;
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
        role="dialog" aria-modal="true" aria-label="Incident video clip" className="relative bg-white border border-sensara-border rounded-xl p-4 max-w-2xl w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sensara-forest-900 font-semibold text-sm">
            📹 Video Clip — {eventLabel}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close video clip" className="text-sensara-warm-500 hover:text-sensara-forest-900 text-lg leading-none"
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

      </div>
    </div>
  );
}

const SEVERITY_LABELS: Record<string, string> = { urgent: "Critical", assist: "Needs assistance", watch: "Watching", stable: "Stable" };
const CHANNEL_LABELS: Record<string, string> = { photon: "iMessage", imessage: "iMessage", sms: "SMS", email: "Email", voice: "Voice" };
const readable = (value: string) => value.replace(/_/g, " ");

export default function EventTimeline({ events, onAcknowledge, onAddNote, onResolve, onDismiss, notifications = [], onRetryNotification, emptyMessage = "No saved incidents" }: EventTimelineProps) {
  const [closureReason, setClosureReason] = useState<Record<string, string>>({});
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState<Record<string, string>>({});
  const [viewingClip, setViewingClip] = useState<{ clipId: string; label: string } | null>(null);
  const deduplicated = events.filter((event, index, all) => all.findIndex(other => other._id === event._id) === index);

  const perform = async (id: string, action: () => Promise<void>) => {
    setPendingId(id); setActionMessage(null);
    try { await action(); }
    catch (error) { setActionMessage(error instanceof Error ? error.message : "Action failed. Please retry."); }
    finally { setPendingId(null); }
  };

  return <>
    {actionMessage && <p role="status" className="panel-message">{actionMessage}</p>}
    <div className="incident-list custom-scrollbar">
      {deduplicated.length === 0 && <p className="incident-empty">{emptyMessage}</p>}
      {deduplicated.map(event => {
        const id = event._id ?? "";
        const expanded = expandedId === id;
        const closed = ["resolved", "dismissed"].includes(event.status ?? "");
        const notices = notifications.filter(notice => notice.eventId === id);
        return <article key={id} className="incident-item">
          <button className="incident-summary" aria-expanded={expanded} aria-controls={`incident-${id}`}
            onClick={() => setExpandedId(expanded ? null : id)}>
            <span className={`incident-badge incident-badge--${closed ? "stable" : event.severity}`}>
              {closed ? readable(event.status!) : SEVERITY_LABELS[event.severity]}
            </span>
            <h3>{EVENT_LABELS[event.eventType] ?? readable(event.eventType)}</h3>
            <p className="incident-room">{event.room}</p>
            <p className="incident-resident">{residentDisplayName(event.residentId, event.residentName)}</p>
            <p className="incident-description">{event.reason}</p>
          </button>
          {expanded && <div className="incident-detail" id={`incident-${id}`}>
            <div className="incident-meta"><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
              <span>{readable(event.status ?? (event.acknowledged ? "acknowledged" : "open"))}</span></div>
            {event.audioTranscript && <p className="incident-transcript">“{event.audioTranscript}”</p>}
            {event.workflow && <div className="notification-progress" aria-label="Notification progress">
              <p><span>Video</span><span>{readable(event.workflow.video.status)}</span></p>
              {event.workflow.video.error && <p className="notification-error">{event.workflow.video.error}</p>}
              <p><span>Voice</span><span>{readable(event.workflow.voice.status)}</span></p>
              {event.workflow.voice.error && <p className="notification-error">{event.workflow.voice.error}</p>}
              <p><span>Messages</span><span>{event.workflow.messaging.status === "configuration_failed" ? "No recipient configured" : readable(event.workflow.messaging.status)}</span></p>
              {event.workflow.messaging.error && <p className="notification-error">{event.workflow.messaging.error}</p>}
            </div>}
            {notices.map(notice => <div key={notice.id} className="notification-result">
              <span>{CHANNEL_LABELS[notice.channel] ?? notice.channel} · {notice.staffId}</span>
              <span>{readable(notice.status)}</span>
              {notice.error && <p className="notification-error">{notice.error}</p>}
              {["failed", "unknown"].includes(notice.status) && notice.channel !== "voice" && onRetryNotification && (
                <button className="text-action" disabled={pendingId === id} onClick={() => void perform(id, () => onRetryNotification(notice))}>Retry</button>
              )}
            </div>)}
            <div className="incident-actions">
              {event.hasVideoClip && event.videoClipId && <button className="quiet-button"
                onClick={() => setViewingClip({ clipId: event.videoClipId!, label: EVENT_LABELS[event.eventType] ?? event.eventType })}>View clip</button>}
              {!closed && event.severity !== "stable" && !event.acknowledged && id && <button className="quiet-button" disabled={pendingId === id}
                onClick={() => void perform(id, () => onAcknowledge(id))}>Acknowledge</button>}
            </div>
            {!closed && (onResolve || onDismiss) && <div className="incident-closure">
              <label>Closure reason<input value={closureReason[id] ?? ""} maxLength={2000}
                onChange={change => setClosureReason(previous => ({ ...previous, [id]: change.target.value }))} /></label>
              <div className="incident-actions">
                {event.acknowledged && onResolve && <button className="quiet-button" disabled={!closureReason[id]?.trim() || pendingId === id}
                  onClick={() => void perform(id, () => onResolve(id, closureReason[id]))}>Resolve</button>}
                {onDismiss && <button className="quiet-button" disabled={!closureReason[id]?.trim() || pendingId === id}
                  onClick={() => void perform(id, () => onDismiss(id, closureReason[id]))}>Dismiss</button>}
              </div>
            </div>}
            {id && <form className="incident-note" onSubmit={submit => {
              submit.preventDefault(); const note = noteText[id]?.trim();
              if (note) void perform(id, async () => { await onAddNote(id, event.residentId, note); setNoteText(previous => ({ ...previous, [id]: "" })); setActionMessage("Note saved."); });
            }}>
              <input aria-label="Caregiver note" placeholder="Add a note…" value={noteText[id] ?? ""}
                onChange={change => setNoteText(previous => ({ ...previous, [id]: change.target.value }))} />
              <button className="quiet-button" disabled={!noteText[id]?.trim() || pendingId === id}>Save</button>
            </form>}
          </div>}
        </article>;
      })}
    </div>
    {viewingClip && <VideoClipModal clipId={viewingClip.clipId} eventLabel={viewingClip.label} onClose={() => setViewingClip(null)} />}
  </>;
}
