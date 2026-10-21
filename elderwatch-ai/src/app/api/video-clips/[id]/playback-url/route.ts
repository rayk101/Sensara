export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getVideoClipById } from "@/lib/db/videoClips";
import { isS3Configured, createPresignedDownloadUrl } from "@/lib/s3";

// GET /api/video-clips/[id]/playback-url
// Looks up the clip in MongoDB, generates a temporary presigned GET URL.
// Clips are never served publicly — all playback requires a fresh signed URL.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const clip = await getVideoClipById(id);
    if (!clip) {
      return NextResponse.json({ error: "Clip not found" }, { status: 404 });
    }

    if (!isS3Configured()) {
      return NextResponse.json(
        { s3Disabled: true, message: "S3 not configured — no playback URL available for demo clips." },
        { status: 503 }
      );
    }

    const playbackUrl = await createPresignedDownloadUrl(clip.s3Key);
    return NextResponse.json({ playbackUrl, clipId: clip._id, durationSeconds: clip.durationSeconds });
  } catch (err) {
    console.error("GET /api/video-clips/[id]/playback-url error:", err);
    return NextResponse.json({ error: "Failed to generate playback URL" }, { status: 500 });
  }
}
