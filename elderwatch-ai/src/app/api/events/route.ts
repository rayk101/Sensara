import { NextResponse } from "next/server";
import { getRecentEvents, getEventsByResident, createSafetyEvent } from "@/lib/db/events";
import { RECOMMENDED_ACTIONS } from "@/lib/classifySafety";
import { sendUrgentSmsAlert } from "@/lib/sms";
import { sendUrgentPhotonAlert } from "@/lib/photon";
import { sendUrgentEmailAlert } from "@/lib/emailAlerts";
import { EventType, ResidentStatus, type SafetyEvent, type SafetySignals } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_SIGNALS: SafetySignals = {
  isLyingDown: false, movementScore: 0, postureAngle: 0,
  secondsStill: 0, insideSafeZone: true, visible: false,
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return NextResponse.json({ error: "limit must be an integer between 1 and 200" }, { status: 400 });
  }
  try {
    const residentId = searchParams.get("residentId");
    const events = residentId
      ? await getEventsByResident(residentId, limit)
      : await getRecentEvents(limit);
    return NextResponse.json({ events });
  } catch (err) {
    console.error("GET /api/events error:", err);
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const { residentId, residentName, room, severity, eventType, confidence, reason } = body;
  const source = body.source ?? "live_camera";
  const strings = [residentId, residentName, room, reason];
  if (strings.some(value => typeof value !== "string" || !value.trim()) ||
      !Object.values(ResidentStatus).includes(severity) ||
      !Object.values(EventType).includes(eventType) ||
      typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
      !["live_camera", "audio_monitor", "manual", "multi_feed_demo"].includes(source)) {
    return NextResponse.json({ error: "Invalid or missing event fields" }, { status: 400 });
  }
  const signals = body.signals ?? DEFAULT_SIGNALS;
  if (typeof signals !== "object" || signals === null ||
      ["isLyingDown", "insideSafeZone", "visible"].some(key => typeof signals[key] !== "boolean") ||
      ["movementScore", "postureAngle", "secondsStill"].some(key => typeof signals[key] !== "number" || !Number.isFinite(signals[key]) || signals[key] < 0)) {
    return NextResponse.json({ error: "Invalid safety signals" }, { status: 400 });
  }
  try {
    const event: Omit<SafetyEvent, "_id"> = {
      residentId, residentName, room, severity, eventType, confidence, reason,
      recommendedAction: RECOMMENDED_ACTIONS[eventType] ?? "",
      signals, source,
      acknowledged: false, acknowledgedBy: null, acknowledgedAt: null,
      hasVideoClip: false, videoClipId: null, videoClip: null,
      createdAt: new Date().toISOString(),
    };
    const created = await createSafetyEvent(event);
    if (created.severity === "urgent") {
      void Promise.allSettled([sendUrgentSmsAlert(created), sendUrgentEmailAlert(created), sendUrgentPhotonAlert(created)]);
    }
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    console.error("POST /api/events error:", err);
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}
