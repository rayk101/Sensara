"use client";

import { useEffect, useState, type RefObject } from "react";

export function useDemoPlayback(videoRef: RefObject<HTMLVideoElement>, isPaused: boolean, sessionId: string | null) {
  const [status, setStatus] = useState<"paused" | "starting" | "playing" | "blocked">("paused");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    if (isPaused || !sessionId) {
      video.pause();
      setStatus("paused");
    } else {
      setStatus("starting");
      // A pause or session change may reject an older play promise. It must
      // not replace the next attempt's state or unmount the video element.
      void video.play().catch(() => { if (!cancelled) setStatus("blocked"); });
    }
    return () => { cancelled = true; };
  }, [videoRef, isPaused, sessionId, attempt]);

  return { status, setStatus, retry: () => setAttempt(n => n + 1) };
}
