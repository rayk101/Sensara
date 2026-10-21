"use client";

import { useEffect, useRef, useState } from "react";
import type { SafetyEvent } from "@/lib/types";

export type RecordingStatus = "idle" | "capturing" | "uploading" | "saved" | "error" | "s3-disabled";
const CLIP_DURATION_MS = 15_000;
const COOLDOWN_MS = 120_000;
const TRIGGER_EVENTS = new Set(["possible_fall", "seizure_like_motion", "possible_choking", "audio_distress", "possible_fall_sound"]);

// A clip belongs to the persisted event that triggered it, even if the user
// switches residents or the current classification changes during recording.
export function useVideoRecorder(
  stream: MediaStream | null,
  event: SafetyEvent | null,
  micStream: MediaStream | null,
  isPaused: boolean,
  onSaved: (event: SafetyEvent) => void
) {
  const [recordingStatus, setStatus] = useState<RecordingStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const handledRef = useRef(new Set<string>());
  const cooldownRef = useRef<Record<string, number>>({});
  const micRef = useRef(micStream);
  const onSavedRef = useRef(onSaved);
  useEffect(() => { micRef.current = micStream; }, [micStream]);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
  // Acknowledging the same event should not restart or cancel its recording.
  const eventRef = useRef(event);
  useEffect(() => { eventRef.current = event; }, [event]);
  const eventId = event?._id;
  const busyRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, [stream, isPaused]);

  useEffect(() => {
    const capturedEvent = eventRef.current;
    if (busyRef.current || !stream || isPaused || !capturedEvent || !eventId || handledRef.current.has(eventId)) return;
    if (capturedEvent.severity !== "urgent" || !TRIGGER_EVENTS.has(capturedEvent.eventType)) return;
    if (Date.now() - new Date(capturedEvent.createdAt).getTime() > 30_000) return;
    if (Date.now() < (cooldownRef.current[capturedEvent.residentId] ?? 0)) return;
    handledRef.current.add(eventId);
    busyRef.current = true;

    let cancelled = false;
    let recorder: MediaRecorder | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const request = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: controller.signal });

    async function record() {
      try {
        const statusResponse = await request("/api/video-clips/presign-upload");
        if (!statusResponse.ok) throw new Error("Could not check video storage");
        const storage = await statusResponse.json();
        if (!storage.s3Configured) {
          busyRef.current = false;
          setStatus("s3-disabled");
          setStatusMessage("Event saved. Configure S3 to record video clips.");
          return;
        }
        if (typeof MediaRecorder === "undefined") throw new Error("Video recording is not supported in this browser");
        const mic = micRef.current;
        if (cancelled) {  return; }
        const videoTracks = stream!.getVideoTracks().filter(track => track.readyState === "live");
        const audioTracks = mic?.getAudioTracks().filter(track => track.readyState === "live") ?? [];
        if (!videoTracks.length) throw new Error("Camera is unavailable");
        const recordingStream = new MediaStream([...videoTracks, ...audioTracks]);
        const mimeType = ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"].find(type => MediaRecorder.isTypeSupported(type));
        recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
        const chunks: Blob[] = [];
        const clipStartTime = new Date().toISOString();
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        recorder.onerror = () => {
          cancelled = true;
          clearTimeout(timer);
          busyRef.current = false;
          
          setStatus("error");
          setStatusMessage("Video recording failed. The safety event is still saved.");
        };
        recorder.onstop = () => {
          
          if (cancelled || !recorder) return;
          const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
          void upload(blob, clipStartTime, audioTracks.length > 0);
        };
        cooldownRef.current[capturedEvent!.residentId] = Date.now() + COOLDOWN_MS;
        recorder.start(1000);
        setStatus("capturing");
        setStatusMessage("Recording 15-second post-event clip…");
        timer = setTimeout(() => { if (recorder?.state === "recording") recorder.stop(); }, CLIP_DURATION_MS);
      } catch (error) {
        
        if (!cancelled) {
          busyRef.current = false;
          setStatus("error");
          setStatusMessage(error instanceof Error ? error.message : "Could not record clip");
        }
      }
    }

    async function upload(blob: Blob, clipStartTime: string, hasAudioTrack: boolean) {
      setStatus("uploading");
      setStatusMessage("Uploading clip…");
      const clipEndTime = new Date().toISOString();
      try {
        if (!blob.size) throw new Error("The recorded clip was empty");
        const presign = await request("/api/video-clips/presign-upload", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId, residentId: capturedEvent!.residentId, contentType: blob.type, fileSize: blob.size }),
        });
        if (!presign.ok) throw new Error("Could not prepare clip upload");
        const { uploadUrl, uploadId, s3Key, bucket, headers } = await presign.json();
        const uploaded = await request(uploadUrl, { method: "PUT", body: blob, headers: headers ?? { "Content-Type": blob.type, "If-None-Match": "*" } });
        if (!uploaded.ok) throw new Error("Video upload failed");
        const metadata = await request("/api/video-clips", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploadId, eventId, residentId: capturedEvent!.residentId, residentName: capturedEvent!.residentName,
            room: capturedEvent!.room, severity: capturedEvent!.severity, eventType: capturedEvent!.eventType,
            s3Key, bucket, contentType: blob.type, clipStartTime, clipEndTime,
            durationSeconds: Math.round((Date.parse(clipEndTime) - Date.parse(clipStartTime)) / 1000),
            hasVideoTrack: true, hasAudioTrack,
          }),
        });
        if (!metadata.ok) throw new Error("Video uploaded, but its event link could not be saved");
        const saved = await metadata.json();
        if (saved.event) onSavedRef.current(saved.event);
        busyRef.current = false;
        setStatus("saved");
        setStatusMessage(hasAudioTrack ? "Clip saved (audio + video)" : "Clip saved (video only)");
      } catch (error) {
        if (!cancelled) {
          busyRef.current = false;
          setStatus("error");
          setStatusMessage(error instanceof Error ? error.message : "Clip upload failed");
        }
      }
    }
    void record();
    cleanupRef.current = () => {
      cancelled = true;
      busyRef.current = false;
      controller.abort();
      clearTimeout(timer);
      if (recorder && recorder.state !== "inactive") recorder.stop();
      
      setStatus("idle");
      setStatusMessage(null);
    };
  }, [stream, eventId, isPaused]);

  useEffect(() => {
    if (!["saved", "error", "s3-disabled"].includes(recordingStatus)) return;
    const timer = setTimeout(() => { setStatus("idle"); setStatusMessage(null); }, 6000);
    return () => clearTimeout(timer);
  }, [recordingStatus]);

  return { recordingStatus, statusMessage };
}
