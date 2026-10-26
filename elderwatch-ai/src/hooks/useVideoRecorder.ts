"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SafetyEvent } from "@/lib/types";
import { clipPolicy, recordingSource } from "@/lib/clipPolicy";
import { recordingAudio } from "@/lib/recordingAudio";
export type RecordingStatus = "idle" | "preparing" | "capturing" | "uploading" | "saved" | "error" | "s3-disabled";
export interface LiveCaptureTrigger { requestId: string; residentId: string; detectedAt: string }
interface CaptureJob { cancel: () => void; bind: (event: SafetyEvent | null) => void }

// Live capture must not wait for network or audio-resume promises. Only already
// authorized tracks are used; the recorder never requests microphone access.
function immediateAudio(stream: MediaStream, microphone: MediaStream | null, onError: (error: unknown) => void) {
  const tracks = [...new Set([...stream.getAudioTracks(), ...(microphone?.getAudioTracks() ?? [])])].filter(t => t.readyState === "live");
  if (tracks.length < 2) return { tracks, close: () => {} };
  const context = new AudioContext(), destination = context.createMediaStreamDestination();
  const sources = tracks.map(track => context.createMediaStreamSource(new MediaStream([track])));
  sources.forEach(source => source.connect(destination));
  void context.resume().catch(onError);
  return { tracks: destination.stream.getAudioTracks(), close: () => {
    sources.forEach(source => source.disconnect());
    destination.stream.getTracks().forEach(track => track.stop());
    void context.close();
  } };
}

// Live Camera starts locally at the critical transition. Persistence identifies
// that same capture later; neither API latency nor upload latency shifts it.
export function useVideoRecorder(stream: MediaStream | null, event: SafetyEvent | null, micStream: MediaStream | null, isPaused: boolean, onSaved: (event: SafetyEvent) => void, expectedSource?: SafetyEvent["recordingSource"]) {
  const [recordingStatus, setStatus] = useState<RecordingStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const handled = useRef(new Set<string>());
  const jobs = useRef(new Map<string, CaptureJob>());
  const storageReady = useRef<boolean | undefined>(undefined);
  const current = useRef({ stream, event, micStream, isPaused, onSaved, expectedSource });
  useEffect(() => { current.current = { stream, event, micStream, isPaused, onSaved, expectedSource }; }, [stream, event, micStream, isPaused, onSaved, expectedSource]);
  useEffect(() => {
    const active = jobs.current;
    return () => { for (const job of active.values()) job.cancel(); active.clear(); setStatus("idle"); setStatusMessage(null); };
  }, [stream, isPaused, expectedSource]);
  useEffect(() => {
    storageReady.current = undefined;
    if (expectedSource !== "live_camera" || !stream || isPaused) return;
    const controller = new AbortController();
    void fetch("/api/video-clips/presign-upload", { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const body = await response.json();
      if (!controller.signal.aborted) storageReady.current = body.s3Configured === true;
    }).catch(() => {});
    return () => controller.abort();
  }, [stream, isPaused, expectedSource]);

  const startCapture = useCallback((initialEvent: SafetyEvent | null, trigger?: LiveCaptureTrigger) => {
    const { stream, micStream, isPaused, expectedSource } = current.current;
    const source = trigger ? "live_camera" : initialEvent && recordingSource(initialEvent);
    const key = trigger?.requestId ?? initialEvent?._id;
    if (!stream || isPaused || !key || !source || (expectedSource && source !== expectedSource) || jobs.current.has(key)) return;
    if (trigger && storageReady.current === false) { setStatus("s3-disabled"); setStatusMessage("Incident saved. Video storage is unavailable."); return; }
    if (initialEvent && (!initialEvent._id || initialEvent.severity !== "urgent" || initialEvent.hasVideoClip || handled.current.has(initialEvent._id) || (initialEvent.workflow && ["not_requested", "removed"].includes(initialEvent.workflow.video.status)))) return;
    const at = trigger?.detectedAt ?? initialEvent?.firstUrgentAt ?? initialEvent?.createdAt;
    if (!at || Date.now() - Date.parse(at) > 30_000 || jobs.current.size >= 3) {
      setStatus("error"); setStatusMessage(jobs.current.size >= 3 ? "Clip recording is busy with three incidents. This clip could not start." : "This older incident cannot start a new clip. A fresh Critical occurrence will start recording.");
      return;
    }
    if (initialEvent?._id) handled.current.add(initialEvent._id);
    const policy = clipPolicy(source);
    let captured = initialEvent, cancelled = false, failed = false;
    let recorder: MediaRecorder | null = null, releaseAudio = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined, confirmationTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveConfirmation!: (event: SafetyEvent | null) => void;
    const confirmation = new Promise<SafetyEvent | null>(resolve => { resolveConfirmation = resolve; });
    if (captured) resolveConfirmation(captured);
    const controller = new AbortController();
    const request = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: controller.signal });
    const report = (status: string, error?: string) => captured?._id
      ? fetch(`/api/events/${captured._id}/capture`, { method: "PATCH", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, error }) }).catch(() => {})
      : Promise.resolve();
    const finish = () => { clearTimeout(timer); clearTimeout(confirmationTimer); releaseAudio(); releaseAudio = () => {}; jobs.current.delete(key); };
    const cancel = () => {
      cancelled = true; controller.abort(); clearTimeout(timer); clearTimeout(confirmationTimer);
      if (recorder?.state === "recording") recorder.stop();
      resolveConfirmation(null); releaseAudio(); releaseAudio = () => {};
      if (captured) void report("partial", "Monitoring stopped before capture/upload completed; no complete clip is available");
      jobs.current.delete(key);
    };
    jobs.current.set(key, { cancel, bind: saved => {
      if (!trigger || captured || cancelled) return;
      if (!saved?._id || saved.residentId !== trigger.residentId || recordingSource(saved) !== "live_camera" || saved.severity !== "urgent" || saved.hasVideoClip || handled.current.has(saved._id) || (saved.workflow && ["not_requested", "removed"].includes(saved.workflow.video.status))) {
        cancel(); setStatus("idle"); setStatusMessage("No new Critical incident was confirmed; the temporary capture was discarded."); return;
      }
      captured = saved; handled.current.add(saved._id); clearTimeout(confirmationTimer); resolveConfirmation(saved);
      if (recorder?.state === "recording") void report("recording");
    } });
    if (trigger) confirmationTimer = setTimeout(() => {
      cancel(); setStatus("error"); setStatusMessage("The Critical incident could not be confirmed. This temporary capture was discarded.");
    }, 30_000);
    setStatus("preparing"); setStatusMessage(`Critical detected — preparing a ${policy.seconds}-second clip…`);

    const upload = async (blob: Blob, clipStartTime: string, clipEndTime: string, hasAudioTrack: boolean) => {
      try {
        if (!blob.size) throw new Error("Recorded video was empty");
        const durationSeconds = (Date.parse(clipEndTime) - Date.parse(clipStartTime)) / 1000;
        if (durationSeconds < policy.minSeconds || durationSeconds > policy.maxSeconds) { await report("partial", "Capture interval was incomplete"); throw new Error(`Partial recording; no complete ${policy.seconds}-second clip was uploaded`); }
        if (!captured) { setStatus("preparing"); setStatusMessage("15 seconds captured. Confirming the Critical incident before upload…"); }
        const savedEvent = await confirmation;
        if (!savedEvent?._id || cancelled) return;
        await report("captured"); setStatus("uploading"); setStatusMessage("Saving clip to S3…");
        const presign = await request("/api/video-clips/presign-upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId: savedEvent._id, residentId: savedEvent.residentId, contentType: blob.type, fileSize: blob.size }) });
        if (!presign.ok) throw new Error((await presign.json()).error ?? "Upload preparation failed");
        const { uploadUrl, uploadId, headers } = await presign.json();
        await report("uploading");
        const uploaded = await request(uploadUrl, { method: "PUT", body: blob, headers });
        if (!uploaded.ok) throw new Error("Video upload failed");
        const metadata = { uploadId, eventId: savedEvent._id, residentId: savedEvent.residentId, clipStartTime, clipEndTime, hasAudioTrack };
        setStatusMessage("Adding the spoken alert and saving the complete video…");
        let result: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (cancelled) return;
          try {
            result = await request("/api/video-clips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata) });
            if (result.ok || result.status < 500) break;
          } catch (error) { if (cancelled || attempt === 2) throw error; }
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        }
        if (!result?.ok) throw new Error(result ? (await result.json()).error ?? "Uploaded video could not be completed" : "Uploaded video could not be completed");
        const saved = await result.json(); if (saved.event) current.current.onSaved(saved.event);
        setStatus("saved"); setStatusMessage(`Clip saved to S3${saved.fileName ? `: ${saved.fileName}` : ""}`);
      } catch (e) {
        if (!cancelled) { setStatus("error"); setStatusMessage(e instanceof Error ? e.message : "Upload failed"); void report("failed", "Video capture or upload failed; incident and other alerts remain active"); }
      } finally { finish(); }
    };
    const record = (audio: { tracks: MediaStreamTrack[]; close: () => void }) => {
      releaseAudio = audio.close;
      if (cancelled) { finish(); return; }
      if (typeof MediaRecorder === "undefined") throw new Error("Video recording is unsupported");
      const videoTracks = stream.getVideoTracks().filter(t => t.readyState === "live");
      if (!videoTracks.length) throw new Error("Camera is unavailable");
      const recordingStream = new MediaStream([...videoTracks, ...audio.tracks]);
      const mimeType = ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"].find(t => MediaRecorder.isTypeSupported(t));
      if (!mimeType) throw new Error("No supported recording format");
      recorder = new MediaRecorder(recordingStream, { mimeType });
      const chunks: Blob[] = [], startedAt = new Date().toISOString();
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { failed = true; if (recorder?.state === "recording") recorder.stop(); setStatus("error"); setStatusMessage("Recording failed. The incident remains saved."); void report("failed", "Recorder error"); finish(); };
      recorder.onstop = () => {
        if (cancelled || failed || !recorder) return;
        const endedAt = new Date().toISOString();
        void upload(new Blob(chunks, { type: recorder.mimeType || mimeType }), startedAt, endedAt, audio.tracks.length > 0);
      };
      recorder.start(1000);
      void report("recording"); setStatus("capturing"); setStatusMessage(`Critical detected — recording ${policy.seconds} seconds. The clip will save to S3 automatically.`);
      timer = setTimeout(() => { if (recorder?.state === "recording") recorder.stop(); }, policy.seconds * 1000);
    };
    const failure = (e: unknown) => {
      if (!cancelled) { setStatus("error"); setStatusMessage(e instanceof Error ? e.message : "Capture failed"); void report("failed", "Capture could not start"); }
      resolveConfirmation(null); finish();
    };
    if (trigger) {
      // This branch executes synchronously in the detector/button callback.
      try { record(immediateAudio(stream, micStream, error => { failed = true; if (recorder?.state === "recording") recorder.stop(); failure(error); })); } catch (e) { failure(e); }
    } else {
      // Keep the prerecorded demo behavior and configuration check unchanged.
      void (async () => {
        try {
          const response = await request("/api/video-clips/presign-upload");
          if (!response.ok) throw new Error("Could not check video storage");
          if (!(await response.json()).s3Configured) { setStatus("s3-disabled"); setStatusMessage("Incident saved. Video storage is unavailable."); await report("unavailable", "Video storage unavailable"); finish(); return; }
          record(await recordingAudio(stream, micStream));
        } catch (e) { failure(e); }
      })();
    }
  }, []);
  const beginLiveCapture = useCallback((trigger: LiveCaptureTrigger) => startCapture(null, trigger), [startCapture]);
  const bindLiveCapture = useCallback((requestId: string, saved: SafetyEvent | null) => { jobs.current.get(requestId)?.bind(saved); }, []);
  const eventId = event?._id, severity = event?.severity, videoStatus = event?.workflow?.video.status;
  useEffect(() => {
    // Live Camera is triggered locally; a delayed server response must never
    // start another 15 seconds after the original detection.
    if (expectedSource !== "live_camera") startCapture(current.current.event);
  }, [stream, eventId, severity, videoStatus, isPaused, expectedSource, startCapture]);
  return { recordingStatus, statusMessage, beginLiveCapture, bindLiveCapture };
}
