import { NextResponse } from "next/server";
import { ensureIndexes } from "@/lib/db/indexes";
import { seedResidents } from "@/lib/db/residents";
import { seedEvents } from "@/lib/db/events";
import { seedNotes } from "@/lib/db/notes";
import { seedVideoClips } from "@/lib/db/videoClips";
import { isMongoEnabled } from "@/lib/mongodb";
import { isS3Configured } from "@/lib/s3";

export async function POST() {
  if (!isMongoEnabled()) {
    return NextResponse.json({
      message: "Running in demo mode — in-memory data already pre-loaded. No seeding needed.",
      mongoConnected: false,
      s3Configured: isS3Configured(),
    });
  }

  try {
    await ensureIndexes();
    await Promise.all([seedResidents(), seedEvents(), seedNotes(), seedVideoClips()]);
    return NextResponse.json({
      message: "Demo data seeded successfully into MongoDB.",
      mongoConnected: true,
      s3Configured: isS3Configured(),
    });
  } catch (err) {
    console.error("POST /api/seed error:", err);
    return NextResponse.json({ error: "Seed failed", details: String(err) }, { status: 500 });
  }
}
