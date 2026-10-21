"use client";

import { useEffect, useRef, useState } from "react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import type { PoseLandmark } from "@/lib/types";

export type PoseStatus = "idle" | "loading" | "running" | "no-webcam" | "error";

export interface PoseDetectionResult {
  landmarks: PoseLandmark[] | null;
  videoRef: React.RefObject<HTMLVideoElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  status: PoseStatus;
  errorMessage: string | null;
  stream: MediaStream | null;
}

const MEDIAPIPE_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export function usePoseDetection(enabled = true): PoseDetectionResult {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [landmarks, setLandmarks] = useState<PoseLandmark[] | null>(null);
  const [status, setStatus] = useState<PoseStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    setLandmarks(null);
    setStream(null);
    setErrorMessage(null);
    if (!enabled) {
      setStatus("idle");
      return;
    }

    let cancelled = false;
    let camera: MediaStream | null = null;
    let detector: PoseLandmarker | null = null;
    let frame = 0;
    let lastVideoTime = -1;
    const video = videoRef.current;

    const release = () => {
      cancelAnimationFrame(frame);
      camera?.getTracks().forEach(track => track.stop());
      detector?.close();
      detector = null;
      if (video?.srcObject === camera) video.srcObject = null;
    };

    async function init() {
      setStatus("loading");
      try {
        camera = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: "user" }, audio: false,
        });
      } catch {
        if (!cancelled) {
          setStatus("no-webcam");
          setErrorMessage("Camera unavailable. Allow camera access, then switch away and back to retry.");
        }
        return;
      }
      if (cancelled || !video) { release(); return; }
      try {
        video.srcObject = camera;
        await video.play();
        if (cancelled) { release(); return; }
        const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
        if (cancelled) { release(); return; }
        const create = (delegate: "GPU" | "CPU") => PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: "VIDEO", numPoses: 1,
          minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        try { detector = await create("GPU"); }
        catch (error) {
          if (cancelled) return;
          detector = await create("CPU");
        }
        if (cancelled) { release(); return; }
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 480;
        }
        setStream(camera);
        setStatus("running");
        const loop = () => {
          if (cancelled || !detector) return;
          if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
            lastVideoTime = video.currentTime;
            try {
              const result = detector.detectForVideo(video, performance.now());
              setLandmarks(result.landmarks[0] ?? null);
            } catch (error) {
              release();
              setStream(null);
              setLandmarks(null);
              setStatus("error");
              setErrorMessage("Pose detection stopped. Switch away and back to retry.");
              return;
            }
          }
          frame = requestAnimationFrame(loop);
        };
        frame = requestAnimationFrame(loop);
      } catch {
        release();
        if (!cancelled) {
          setStream(null);
          setStatus("error");
          setErrorMessage("Could not load pose detection. Check your network connection and retry.");
        }
      }
    }
    void init();
    return () => { cancelled = true; release(); };
  }, [enabled]);

  return { landmarks, videoRef, canvasRef, status, errorMessage, stream };
}
