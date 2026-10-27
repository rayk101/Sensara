"use client";

import { useState, useRef, useEffect, useCallback, useId } from "react";
import type { ResidentProfile, SafetyEvent } from "@/lib/types";

type MicStatus = "idle" | "requesting" | "listening" | "error";

export interface AudioMonitorProps {
  resident: ResidentProfile | null;
  sessionId?: string | null;
  isPaused?: boolean;
  onEventSaved?: (event: SafetyEvent) => void;
  /** Shares the active microphone with clip recording and voice playback controls. */
  onMicStream?: (stream: MediaStream | null) => void;
}

const CHUNK_DURATION_MS = 6000;

export default function AudioMonitor({ resident, sessionId, isPaused = false, onEventSaved, onMicStream }: AudioMonitorProps) {
  const descriptionId = useId();
  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const [elevenLabsConfigured, setElevenLabsConfigured] = useState<boolean | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const isListeningRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const requestGenerationRef = useRef(0);
  const pendingRequests = useRef(new Set<AbortController>());
  const sessionRef = useRef(sessionId);
  const residentRef = useRef(resident);
  const isPausedRef = useRef(isPaused);
  const onEventRef = useRef(onEventSaved);
  const onMicStreamRef = useRef(onMicStream);

  useEffect(() => { sessionRef.current = sessionId; }, [sessionId]);
  useEffect(() => { residentRef.current = resident; }, [resident]);
  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);
  useEffect(() => { onEventRef.current = onEventSaved; }, [onEventSaved]);
  useEffect(() => { onMicStreamRef.current = onMicStream; }, [onMicStream]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/audio/analyze", { signal: controller.signal })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("Audio unavailable")))
      .then(data => { if (!controller.signal.aborted) setElevenLabsConfigured(data.elevenLabsConfigured === true); })
      .catch(() => { if (!controller.signal.aborted) setElevenLabsConfigured(false); });
    return () => controller.abort();
  }, []);

  const stopListening = useCallback(() => {
    requestGenerationRef.current++;
    isListeningRef.current = false;
    if (chunkTimerRef.current !== null) clearTimeout(chunkTimerRef.current);
    chunkTimerRef.current = null;
    for (const controller of pendingRequests.current) controller.abort();
    pendingRequests.current.clear();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* Already stopped. */ } }
    }
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    onMicStreamRef.current?.(null);
    setMicStatus("idle");
  }, []);

  const sendChunk = useCallback(async (blob: Blob) => {
    const currentResident = residentRef.current;
    if (!currentResident || !sessionRef.current || blob.size < 500 || !isListeningRef.current || isPausedRef.current) return;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    pendingRequests.current.add(controller);
    try {
      const form = new FormData();
      form.append("audio", blob, "chunk.webm");
      form.append("residentId", currentResident.id);
      form.append("residentName", currentResident.name);
      form.append("room", currentResident.room);
      form.append("sessionId", sessionRef.current);
      form.append("idempotencyKey", `${sessionRef.current}:audio:${crypto.randomUUID()}`);
      const response = await fetch("/api/audio/analyze", { method: "POST", body: form, signal: controller.signal });
      const data = await response.json();
      if (generation !== requestGenerationRef.current || controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.error ?? "Audio analysis unavailable");
      setErrorMsg(null);
      if (data.event) onEventRef.current?.(data.event);
    } catch (error) {
      if (generation === requestGenerationRef.current && !controller.signal.aborted) {
        setErrorMsg(error instanceof Error ? error.message : "Audio analysis failed");
      }
    } finally { pendingRequests.current.delete(controller); }
  }, []);

  const recordChunk = useCallback(function recordNextChunk(): boolean {
    const micStream = streamRef.current;
    if (!isListeningRef.current || !micStream) return false;
    const generation = requestGenerationRef.current;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    try {
      const recorder = new MediaRecorder(micStream, mimeType ? { mimeType } : {});
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        if (generation !== requestGenerationRef.current || !isListeningRef.current || isPausedRef.current) return;
        if (chunkTimerRef.current !== null) clearTimeout(chunkTimerRef.current);
        void sendChunk(new Blob(chunks, { type: mimeType || "audio/webm" }));
        chunkTimerRef.current = setTimeout(recordNextChunk, 100);
      };
      recorder.onerror = () => {
        if (generation !== requestGenerationRef.current) return;
        stopListening();
        setMicStatus("error");
        setErrorMsg("Audio recording stopped. Turn the switch on to retry.");
      };
      recorder.start();
      chunkTimerRef.current = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, CHUNK_DURATION_MS);
      return true;
    } catch {
      stopListening();
      setMicStatus("error");
      setErrorMsg("Could not start audio recording. Please try again.");
      return false;
    }
  }, [sendChunk, stopListening]);

  const startListening = useCallback(async () => {
    if (isListeningRef.current || isPausedRef.current || !residentRef.current || !sessionRef.current || !elevenLabsConfigured) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMicStatus("error");
      setErrorMsg("Audio recording is not supported in this browser.");
      return;
    }
    const generation = ++requestGenerationRef.current;
    setMicStatus("requesting");
    setErrorMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }, video: false,
      });
      if (generation !== requestGenerationRef.current || isPausedRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      isListeningRef.current = true;
      for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => {
        if (generation !== requestGenerationRef.current) return;
        stopListening();
        setMicStatus("error");
        setErrorMsg("Microphone disconnected. Turn the switch on to reconnect.");
      }, { once: true });
      if (recordChunk()) {
        setMicStatus("listening");
        onMicStreamRef.current?.(stream);
      }
    } catch (error) {
      if (generation !== requestGenerationRef.current) return;
      stopListening();
      setMicStatus("error");
      const message = error instanceof Error ? error.message : String(error);
      setErrorMsg(/denied|permission|notallowed/i.test(message)
        ? "Microphone permission denied. Allow access in your browser to enable audio."
        : "Could not start the microphone. Please try again.");
    }
  }, [elevenLabsConfigured, recordChunk, stopListening]);

  useEffect(() => { if (isPaused) stopListening(); }, [isPaused, stopListening]);
  useEffect(() => stopListening, [resident?.id, sessionId, stopListening]);

  const isListening = micStatus === "listening";
  const requesting = micStatus === "requesting";
  const disabledReason = isPaused ? "Start the camera to enable audio and voice."
    : !resident || !sessionId ? "Waiting for a monitoring session."
    : elevenLabsConfigured === null ? "Checking ElevenLabs availability."
    : !elevenLabsConfigured ? "ElevenLabs is not configured." : undefined;

  return <div className="elevenlabs-control">
    <div className="elevenlabs-control-row">
      <span>ElevenLabs Audio and Voice Enabled</span>
      <button type="button" role="switch" aria-label="ElevenLabs Audio and Voice Enabled"
        aria-checked={isListening} aria-busy={requesting} aria-describedby={descriptionId}
        className="audio-voice-switch" disabled={!isListening && !requesting && !!disabledReason}
        title={disabledReason ?? "Toggle microphone monitoring and spoken alerts"}
        onClick={() => { if (isListening || requesting) stopListening(); else void startListening(); }}>
        <span className="audio-voice-switch-label" aria-hidden="true">{requesting ? "…" : isListening ? "On" : "Off"}</span>
        <span className="audio-voice-switch-thumb" aria-hidden="true" />
      </button>
    </div>
    <p className="sr-only" id={descriptionId}>{disabledReason ?? "On sends microphone audio to ElevenLabs for analysis and enables spoken alerts on this device."}</p>
    {errorMsg && <p className="audio-voice-error" role="alert">{errorMsg}</p>}
  </div>;
}
