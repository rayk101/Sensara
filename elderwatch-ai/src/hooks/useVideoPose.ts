"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { analyzePoseWindow, POSE_POLICY, type PoseFrame } from "@/lib/poseEvidence";

export interface PoseFrameContext { time: number; aspect: number }
export function useVideoPose(videoRef: RefObject<HTMLVideoElement>, enabled: boolean,
  onFrame?: (landmarks: PoseFrame["landmarks"], context: PoseFrameContext) => void, resetKey?: string) {
  const callback = useRef(onFrame);
  useEffect(() => { callback.current = onFrame; }, [onFrame]);
  const frames = useRef<PoseFrame[]>([]);
  const [observation, setObservation] = useState(() => analyzePoseWindow([]));
  const [lastFrame, setLastFrame] = useState<PoseFrame | null>(null);
  const [status, setStatus] = useState<"paused" | "loading" | "tracking" | "error">("paused");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    frames.current = []; setError(null);
    if (!enabled) { setStatus("paused"); return; }
    setObservation(analyzePoseWindow([])); setLastFrame(null);
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false, busy = false, ready = false, lastTime = -1, lastResultAt = performance.now(), stale = false;
    let frameDeadline: ReturnType<typeof setTimeout> | undefined;
    let worker: Worker;
    try { worker = new Worker('/pose-worker.js'); }
    catch { setStatus('error'); setError('This browser could not start body tracking.'); return; }
    setStatus("loading");
    const fail = (message: string) => {
      if (cancelled) return;
      ready = false; busy = false; clearTimeout(startup); clearTimeout(frameDeadline); worker.terminate(); frames.current = [];
      setStatus("error"); setError(message); setObservation(analyzePoseWindow([])); setLastFrame(null); callback.current?.(null, { time: video.currentTime, aspect: video.videoWidth / video.videoHeight || 4 / 3 });
    };
    const startup = setTimeout(() => fail("Body tracking load timed out. Pause and play to retry."), 30000);
    worker.onerror = () => fail("Body tracking failed. Pause and play to retry.");
    worker.onmessage = ({ data }) => {
      if (cancelled) return;
      if (data.type === 'ready') { clearTimeout(startup); ready = true; setStatus("tracking"); }
      if (data.type === 'error') { clearTimeout(startup); fail(data.message); }
      if (data.type === 'pose') {
        busy = false; clearTimeout(frameDeadline);
        lastResultAt = performance.now(); stale = false;
        if (video.seeking || Math.abs(video.currentTime - data.time) > 1) { frames.current = []; setObservation(analyzePoseWindow([])); return; }
        if (!ready) return;
        if (data.time < (frames.current.at(-1)?.time ?? -1)) frames.current = [];
        frames.current = [...frames.current.filter(f => data.time - f.time <= POSE_POLICY.windowSeconds), { time: data.time, landmarks: data.landmarks }].slice(-80);
        setLastFrame(frames.current.at(-1) ?? null);
        setObservation(analyzePoseWindow(frames.current, video.videoWidth / video.videoHeight || 16 / 9));
        callback.current?.(data.landmarks, { time: data.time, aspect: video.videoWidth / video.videoHeight || 4 / 3 });
      }
    };
    worker.postMessage({ type: 'init' });
    const interval = setInterval(async () => {
      if (ready && !stale && performance.now() - lastResultAt > 2000) { stale = true; frames.current = []; setObservation(analyzePoseWindow([])); setLastFrame(null); callback.current?.(null, { time: video.currentTime, aspect: video.videoWidth / video.videoHeight || 4 / 3 }); }
      if (!ready || busy || video.paused || video.seeking || video.readyState < 2 || video.currentTime === lastTime) return;
      busy = true; lastTime = video.currentTime;
      const time = lastTime;
      frameDeadline = setTimeout(() => fail("Body tracking stopped responding. Pause and play to retry."), 5000);
      try {
        const bitmap = await createImageBitmap(video, { resizeWidth: 640, resizeHeight: Math.round(640 * (video.videoHeight / video.videoWidth || 9 / 16)) });
        if (cancelled || !ready) { bitmap.close(); return; }
        worker.postMessage({ type: 'frame', bitmap, time, timestamp: performance.now(), aspect: video.videoWidth / video.videoHeight || 16 / 9 }, [bitmap]);
      } catch { fail("Video frame could not be read for body tracking."); }
    }, 200);
    return () => { cancelled = true; clearTimeout(startup); clearTimeout(frameDeadline); clearInterval(interval); worker.terminate(); frames.current = []; };
  }, [enabled, videoRef, resetKey]);
  return { observation, frames, lastFrame, status, error };
}
