export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { createVideoClip, getVideoClipsByResident } from "@/lib/db/videoClips";
import { getSafetyEvent, linkVideoClipToEvent } from "@/lib/db/events";
import type { VideoClip } from "@/lib/types";

// POST /api/video-clips — Save clip metadata after a successful S3 upload
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      residentId, residentName, room, severity, eventType,
      s3Key, bucket, contentType, durationSeconds,
      clipStartTime, clipEndTime, eventId,
    } = body;

    if (!residentId || !s3Key || !bucket) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (eventId) {
      const event = await getSafetyEvent(eventId);
      if (!event || event.residentId !== residentId) {
        return NextResponse.json({ error: "Matching event not found" }, { status: 404 });
      }
    }
    const clip: Omit<VideoClip, "_id"> = {
      eventId: eventId ?? null,
      residentId,
      residentName,
      room,
      severity,
      eventType,
      s3Key,
      bucket,
      contentType: contentType || "video/webm",
      durationSeconds: durationSeconds || 0,
      clipStartTime: clipStartTime || new Date().toISOString(),
      clipEndTime: clipEndTime || new Date().toISOString(),
      hasAudioTrack: body.hasAudioTrack === true,
      hasVideoTrack: body.hasVideoTrack !== false,
      createdAt: new Date().toISOString(),
    };

    const created = await createVideoClip(clip);
    const event = eventId ? await linkVideoClipToEvent(eventId, created._id!, {
      s3Key: clip.s3Key, bucket: clip.bucket, contentType: clip.contentType,
      clipStartTime: clip.clipStartTime, clipEndTime: clip.clipEndTime, durationSeconds: clip.durationSeconds,
    }) : null;
    return NextResponse.json({ ...created, event }, { status: 201 });
  } catch (err) {
    console.error("POST /api/video-clips error:", err);
    return NextResponse.json({ error: "Failed to save clip metadata" }, { status: 500 });
  }
}

// GET /api/video-clips?residentId=xxx
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const residentId = searchParams.get("residentId");
  try {
    if (!residentId) {
      return NextResponse.json({ error: "residentId is required" }, { status: 400 });
    }
    const clips = await getVideoClipsByResident(residentId);
    return NextResponse.json({ clips });
  } catch (err) {
    console.error("GET /api/video-clips error:", err);
    return NextResponse.json({ error: "Failed to fetch clips" }, { status: 500 });
  }
}
