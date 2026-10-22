"use client";

import { useEffect, useRef, useState } from "react";
import type { PoseLandmark } from "@/lib/types";
import { useVideoPose, type PoseFrameContext } from "./useVideoPose";

export type PoseStatus = "idle" | "loading" | "running" | "no-webcam" | "error";

/** Camera acquisition and local worker initialization start independently. */
export function usePoseDetection(enabled = true,
  onFrame?: (landmarks: PoseLandmark[] | null, context: PoseFrameContext) => void,
  deviceId?: string, patientId?: string) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cameraStatus, setCameraStatus] = useState<PoseStatus>("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${patientId}:${deviceId}:${attempt}`;
  const pose = useVideoPose(videoRef, enabled && cameraStatus !== "no-webcam" && cameraStatus !== "error", onFrame, key);
  const frameCallback = useRef(onFrame);
  useEffect(() => { frameCallback.current = onFrame; }, [onFrame]);

  useEffect(() => {
    setStream(null); setCameraError(null);
    if (!enabled) { setCameraStatus("idle"); return; }
    let cancelled = false;
    let camera: MediaStream | null = null;
    const video = videoRef.current;
    const release = () => {
      camera?.getTracks().forEach(track => track.stop());
      if (video?.srcObject === camera) video.srcObject = null;
    };
    setCameraStatus("loading");
    const timeout = setTimeout(() => {
      if (!cancelled) setCameraError("Waiting for camera access. Check the browser's camera permission prompt, or retry.");
    }, 12000);
    void (async () => {
      try {
        camera = await navigator.mediaDevices.getUserMedia({ video: {
          width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
        }, audio: false });
        clearTimeout(timeout);
        if (cancelled || !video) { release(); return; }
        camera.getVideoTracks().forEach(track => track.addEventListener("ended", () => {
          if (cancelled) return;
          release(); setStream(null); setCameraStatus("error");
          setCameraError("Camera disconnected. Existing incidents remain active. Retry camera to reconnect.");
          frameCallback.current?.(null, { time: video.currentTime, aspect: video.videoWidth / video.videoHeight || 4 / 3 });
        }, { once: true }));
        video.srcObject = camera;
        // Preview is available before model initialization finishes.
        await video.play();
        if (cancelled) { release(); return; }
        setStream(camera); setCameraError(null); setCameraStatus("running");
      } catch (error) {
        clearTimeout(timeout); release();
        if (!cancelled) {
          setStream(null); setCameraStatus("no-webcam");
          const denied = error instanceof Error && error.name === "NotAllowedError";
          setCameraError(denied ? "Camera access is blocked. Allow it in this site's browser settings, then retry camera." : "Camera unavailable. Check that it is connected and not in use by another application, then retry.");
        }
      }
    })();
    return () => { cancelled = true; clearTimeout(timeout); release(); };
  }, [enabled, deviceId, patientId, attempt]);

  const status: PoseStatus = !enabled ? "idle" : cameraStatus === "no-webcam" || cameraStatus === "error" ? cameraStatus
    : pose.status === "error" ? "error" : cameraStatus === "running" && pose.status === "tracking" ? "running" : "loading";
  return { landmarks: enabled && status === "running" ? pose.lastFrame?.landmarks ?? null : null,
    videoRef, canvasRef, status, errorMessage: cameraError || pose.error, stream,
    retry: () => { setCameraStatus("loading"); setAttempt(n => n + 1); } };
}
