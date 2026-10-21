"use client";

import { useEffect, useRef } from "react";
import type { ResidentStatusValue, ResidentProfile, SafetyClassification } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// useAlerts — Manages TTS (browser speechSynthesis) and visual alert state.
// Debounces alerts so they do not spam continuously.
// ─────────────────────────────────────────────────────────────────────────────

const TTS_DEBOUNCE_MS = 15_000; // Min time between TTS announcements

export function useAlerts(
  classification: SafetyClassification | null,
  resident: ResidentProfile | null
) {
  const lastTTSRef = useRef<Record<string, number>>({});
  const prevSeverityRef = useRef<ResidentStatusValue | null>(null);

  useEffect(() => {
    if (!classification || !resident) {
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
      return;
    }
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const { severity, eventType, reason } = classification;

    // Only speak for Assist or Urgent, and only when severity changes
    if (severity !== "assist" && severity !== "urgent") {
      prevSeverityRef.current = severity;
      return;
    }

    const now = Date.now();
    const key = `${resident.id}:${eventType}`;
    const lastTime = lastTTSRef.current[key] ?? 0;

    const severityChanged = prevSeverityRef.current !== severity;
    const debouncePassed = now - lastTime > TTS_DEBOUNCE_MS;

    if (debouncePassed && (severityChanged || !lastTime)) {
      lastTTSRef.current[key] = now;
      prevSeverityRef.current = severity;

      const label = severity === "urgent" ? "Urgent alert" : "Caregiver assist needed";
      const utteranceText = `${label}. ${reason}. Resident: ${resident.name}, ${resident.room}.`;

      // Cancel any in-progress speech first
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(utteranceText);
      utterance.rate = 0.9;
      utterance.pitch = 1.1;
      utterance.volume = 1;
      window.speechSynthesis.speak(utterance);
    }
  }, [classification, resident]);
}
