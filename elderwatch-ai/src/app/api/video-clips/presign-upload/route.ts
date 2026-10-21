export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { isS3Configured, createPresignedUploadUrl, getS3Bucket } from "@/lib/s3";

// GET /api/video-clips/presign-upload — lightweight S3 status check, no URL generated
export async function GET() {
  return NextResponse.json({ s3Configured: isS3Configured() });
}

// POST /api/video-clips/presign-upload
// Returns a presigned S3 PUT URL so the browser can upload a clip directly to S3.
// No video data passes through the Next.js server.

export async function POST(req: Request) {
  if (!isS3Configured()) {
    return NextResponse.json(
      { s3Disabled: true, message: "S3 not configured. Set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_S3_BUCKET." },
      { status: 503 }
    );
  }

  try {
    const { residentId, eventType, contentType } = await req.json();

    if (!residentId || !eventType) {
      return NextResponse.json({ error: "Missing residentId or eventType" }, { status: 400 });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = contentType?.includes("mp4") ? "mp4" : "webm";
    const s3Key = `critical-events/${residentId}/${eventType}_${timestamp}.${ext}`;

    const uploadUrl = await createPresignedUploadUrl({
      key: s3Key,
      contentType: contentType || "video/webm",
    });

    return NextResponse.json({
      uploadUrl,
      s3Key,
      bucket: getS3Bucket(),
    });
  } catch (err) {
    console.error("POST /api/video-clips/presign-upload error:", err);
    return NextResponse.json({ error: "Failed to generate presigned URL" }, { status: 500 });
  }
}
