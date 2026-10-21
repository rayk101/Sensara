"use client";
import { useEffect, useRef, useState } from "react";
import type { SafetyEvent } from "@/lib/types";
export type RecordingStatus = "idle" | "capturing" | "uploading" | "saved" | "error" | "s3-disabled";
const CLIP_DURATION_MS = 15_000;
// The browser owns capture. Up to three independent urgent incidents may share
// a camera stream; each retains its own immutable patient/incident snapshot.
export function useVideoRecorder(stream: MediaStream | null, event: SafetyEvent | null, micStream: MediaStream | null, isPaused: boolean, onSaved: (event: SafetyEvent) => void) {
  const [recordingStatus, setStatus] = useState<RecordingStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const handled = useRef(new Set<string>());
  const jobs = useRef(new Map<string, () => void>());
  const current = useRef({ event, micStream, onSaved });
  useEffect(() => { current.current = { event, micStream, onSaved }; }, [event, micStream, onSaved]);
  useEffect(() => {
    const active = jobs.current;
    return () => { for (const cancel of active.values()) cancel(); active.clear(); setStatus("idle"); setStatusMessage(null); };
  }, [stream, isPaused]);
  const eventId = event?._id;
  useEffect(() => {
    const captured = current.current.event;
    if (!stream || isPaused || !captured || !eventId || captured.severity !== "urgent" || (captured.workflow && captured.workflow.video.status === "not_requested") || captured.hasVideoClip || handled.current.has(eventId)) return;
    handled.current.add(eventId);
    const report = (status: string, error?: string) => fetch(`/api/events/${eventId}/capture`, { method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, error }) }).catch(() => {});
    if (Date.now() - Date.parse(captured.firstUrgentAt ?? captured.createdAt) > 30_000 || jobs.current.size >= 3) {
      void report("unavailable", "Camera capture was unavailable when this incident occurred"); return;
    }
    let cancelled = false, failed = false;
    let recorder: MediaRecorder | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const request = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: controller.signal });
    const finish = () => { clearTimeout(timer); jobs.current.delete(eventId); };
    jobs.current.set(eventId, () => {
      cancelled = true; controller.abort(); clearTimeout(timer);
      if (recorder?.state === "recording") recorder.stop();
      void report("partial", "Monitoring stopped before capture/upload completed; no complete clip is available");
    });
    const run = async () => {
      try {
        const response = await request("/api/video-clips/presign-upload");
        if (!response.ok) throw new Error("Could not check video storage");
        if (!(await response.json()).s3Configured) { setStatus("s3-disabled"); setStatusMessage("Incident saved. Video storage is unavailable."); await report("unavailable", "Video storage unavailable"); finish(); return; }
        if (typeof MediaRecorder === "undefined") throw new Error("Video recording is unsupported");
        const videoTracks = stream.getVideoTracks().filter(t => t.readyState === "live");
        if (!videoTracks.length) throw new Error("Camera is unavailable");
        const audioTracks = current.current.micStream?.getAudioTracks().filter(t => t.readyState === "live") ?? [];
        const recordingStream = new MediaStream([...videoTracks, ...audioTracks]);
        const mimeType = ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"].find(t => MediaRecorder.isTypeSupported(t));
        if (!mimeType) throw new Error("No supported recording format");
        if (cancelled) return;
        recorder = new MediaRecorder(recordingStream, { mimeType });
        const chunks: Blob[] = [];
        const startedAt = new Date().toISOString();
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        recorder.onerror = () => { failed = true; if (recorder?.state === "recording") recorder.stop(); clearTimeout(timer); setStatus("error"); setStatusMessage("Recording failed. The incident remains saved."); void report("failed", "Recorder error"); finish(); };
        recorder.onstop = () => {
          if (cancelled || failed || !recorder) return;
          const endedAt = new Date().toISOString();
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
          void upload(blob, startedAt, endedAt, audioTracks.length > 0);
        };
        recorder.start(1000);
        void report("recording"); setStatus("capturing"); setStatusMessage("Recording 15-second post-event footage…");
        timer = setTimeout(() => { if (recorder?.state === "recording") recorder.stop(); }, CLIP_DURATION_MS);
      } catch (e) {
        if (!cancelled) { setStatus("error"); setStatusMessage(e instanceof Error ? e.message : "Capture failed"); void report("failed", "Capture could not start"); }
        finish();
      }
    };
    const upload = async (blob: Blob, clipStartTime: string, clipEndTime: string, hasAudioTrack: boolean) => {
      try {
        if (!blob.size) throw new Error("Recorded video was empty");
        const durationSeconds = (Date.parse(clipEndTime) - Date.parse(clipStartTime)) / 1000;
        if (durationSeconds < 14 || durationSeconds > 20) { await report("partial", "Capture interval was incomplete"); throw new Error("Partial recording; no complete 15-second clip was uploaded"); }
        await report("captured");
        setStatus("uploading"); setStatusMessage("Uploading post-event clip…");
        const presign = await request("/api/video-clips/presign-upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId, residentId: captured.residentId, contentType: blob.type, fileSize: blob.size }) });
        if (!presign.ok) throw new Error((await presign.json()).error ?? "Upload preparation failed");
        const { uploadUrl, uploadId, headers } = await presign.json();
        await report("uploading");
        const uploaded = await request(uploadUrl, { method: "PUT", body: blob, headers });
        if (!uploaded.ok) throw new Error("Video upload failed");
        const metadata = { uploadId, eventId, residentId: captured.residentId, clipStartTime, clipEndTime, hasAudioTrack };
        let result: Response | null = null;
        // Retry only metadata completion; never re-record or overwrite the S3 object.
        for (let attempt = 0; attempt < 3; attempt++) {
          result = await request("/api/video-clips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata) });
          if (result.ok || result.status < 500) break;
          await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        }
        if (!result?.ok) throw new Error("Uploaded video could not be verified or linked");
        const saved = await result.json(); if (saved.event) current.current.onSaved(saved.event);
        setStatus("saved"); setStatusMessage("15-second post-event clip saved");
      } catch (e) {
        if (!cancelled) { setStatus("error"); setStatusMessage(e instanceof Error ? e.message : "Upload failed"); void report("failed", "Video capture or upload failed; incident and other alerts remain active"); }
      } finally { finish(); }
    };
    void run();
  }, [stream, eventId, isPaused]);
  return { recordingStatus, statusMessage };
}
