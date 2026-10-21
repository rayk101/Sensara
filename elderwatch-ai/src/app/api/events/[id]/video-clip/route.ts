import { NextResponse } from "next/server";
import { linkVideoClipToEvent } from "@/lib/db/events";

// PATCH /api/events/[id]/video-clip
// Links a saved S3 clip to its originating safety event. Called by useVideoRecorder
// after a successful clip upload so the event shows the "📹 Video Clip" badge.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json();
    const { clipId, s3Key, bucket, contentType, durationSeconds, clipStartTime, clipEndTime } = body;

    if (!clipId || !s3Key || !bucket) {
      return NextResponse.json({ error: "Missing clipId, s3Key, or bucket" }, { status: 400 });
    }

    const updated = await linkVideoClipToEvent(id, clipId, {
      s3Key,
      bucket,
      contentType: contentType ?? "video/webm",
      durationSeconds: durationSeconds ?? 0,
      clipStartTime: clipStartTime ?? new Date().toISOString(),
      clipEndTime: clipEndTime ?? new Date().toISOString(),
    });

    if (!updated) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return NextResponse.json(updated);
  } catch (err) {
    console.error("PATCH /api/events/[id]/video-clip error:", err);
    return NextResponse.json({ error: "Failed to link video clip to event" }, { status: 500 });
  }
}
