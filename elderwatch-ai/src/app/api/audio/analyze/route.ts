import { getResidentById } from "@/lib/db/residents";
import { withAuth } from "@/lib/platform/auth";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  isElevenLabsConfigured,
  transcribeAudioWithElevenLabs,
  classifyAudioTranscript,
  type AudioClassification,
} from "@/lib/elevenlabs";
import { submitIncident } from "@/lib/platform/incidents";
import type { SafetyEvent } from "@/lib/types";

// GET — lightweight ElevenLabs status check
async function GETHandler() {
  return NextResponse.json({ elevenLabsConfigured: isElevenLabsConfigured() });
}

// POST /api/audio/analyze
// Accepts multipart/form-data with an audio blob. Calls ElevenLabs STT,
// classifies for distress, and persists a safety event if severity >= watch.
// Also supports { simulate: true } JSON body for demo triggers.
async function POSTHandler(req: Request) {
  try {
    const contentType = req.headers.get("content-type") ?? "";

    let classification: AudioClassification;
    let transcript = "";
    let residentId = "resident_001";
    let residentName = "Eleanor Brooks";
    let room = "Room 204";
    let isSimulation = false;
    let sessionId: string | null = null;
    let requestId: string | null = null;

    if (contentType.includes("multipart/form-data")) {
      // Real audio analysis
      if (!isElevenLabsConfigured()) {
        return NextResponse.json(
          { elevenLabsDisabled: true, message: "ELEVENLABS_API_KEY not set" },
          { status: 503 }
        );
      }

      const form = await req.formData();
      const audioFile = form.get("audio") as File | null;
      residentId = (form.get("residentId") as string) ?? residentId;
      residentName = (form.get("residentName") as string) ?? residentName;
      room = (form.get("room") as string) ?? room;

      if (!audioFile) {
        return NextResponse.json({ error: "No audio file provided" }, { status: 400 });
      }

      if (!(audioFile instanceof File) || audioFile.size > 10 * 1024 * 1024 || !/^(audio|video)\//.test(audioFile.type)) return NextResponse.json({ error: "Invalid audio file (maximum 10 MB)" }, { status: 400 });
      sessionId = form.get("sessionId") as string | null;
      requestId = form.get("idempotencyKey") as string | null;
      if (!await getResidentById(residentId)) return NextResponse.json({ error: "Patient not found" }, { status: 404 });
      const buffer = Buffer.from(await audioFile.arrayBuffer());
      const result = await transcribeAudioWithElevenLabs(buffer, audioFile.type || "audio/webm");
      transcript = result.transcript;
      classification = classifyAudioTranscript(transcript, result.audioTags);
    } else {
      // JSON body — simulation or manual trigger
      const body = await req.json();
      residentId = body.residentId ?? residentId;
      residentName = body.residentName ?? residentName;
      room = body.room ?? room;
      isSimulation = body.simulate === true;
      sessionId = body.sessionId ?? null;
      requestId = body.idempotencyKey ?? null;

      if (isSimulation) {
        transcript = "Help! I can't get up. Please help me.";
        classification = classifyAudioTranscript(transcript, ["thud"]);
      } else {
        return NextResponse.json({ error: "Missing audio or simulate flag" }, { status: 400 });
      }
    }

    // Persist event for watch/assist/urgent classifications
    let savedEvent: SafetyEvent | undefined;
    if (classification.severity !== "stable") {
      const signals = {
        isLyingDown: false,
        movementScore: 0,
        postureAngle: 0,
        secondsStill: 0,
        insideSafeZone: true,
        visible: true,
      };
      const event: Omit<SafetyEvent, "_id"> = {
        residentId,
        residentName,
        room,
        severity: classification.severity,
        eventType: classification.eventType,
        confidence: classification.confidence,
        reason: classification.reason + (isSimulation ? " [Simulation]" : ""),
        recommendedAction: AUDIO_RECOMMENDED_ACTIONS[classification.eventType] ?? "",
        signals,
        source: "audio_monitor",
        audioTranscript: transcript || null,
        acknowledged: false,
        acknowledgedBy: null,
        acknowledgedAt: null,
        createdAt: new Date().toISOString(),
      };
      const saved = await submitIncident({ ...event, sessionId, idempotencyKey: requestId });
      savedEvent = saved;


    }

    // Only trigger clip recording for urgent events to avoid S3 spam
    const shouldRecordCriticalClip = classification.severity === "urgent";

    return NextResponse.json({
      classification,
      transcript,
      eventId: savedEvent?._id,
      event: savedEvent,
      shouldRecordCriticalClip,
      elevenLabsEnabled: isElevenLabsConfigured(),
      isSimulation,
    });
  } catch (err) {
    console.error("POST /api/audio/analyze error:", err);
    return NextResponse.json({ error: "Audio analysis failed" }, { status: 500 });
  }
}

const AUDIO_RECOMMENDED_ACTIONS: Record<string, string> = {
  audio_distress:
    "Verbal distress detected via audio. Go to the resident immediately and assess the situation. Call for additional staff if needed.",
  possible_distress_sound:
    "Possible distress sound detected. Perform a visual or in-person check on the resident.",
  possible_fall_sound:
    "A possible fall sound was detected. Check on the resident's location and condition.",
  possible_choking:
    "Possible choking or breathing distress detected. Go to the resident immediately. Ask if they can breathe and speak. Call emergency services if needed.",
};

export const GET = withAuth(GETHandler);
export const POST = withAuth(POSTHandler);
