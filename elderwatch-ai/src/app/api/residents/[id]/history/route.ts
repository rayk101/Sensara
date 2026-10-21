import { withAuth } from "@/lib/platform/auth";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getResidentHistory } from "@/lib/db/events";

const EMPTY_HISTORY = {
  totalEventsToday: 0,
  urgentEvents: 0,
  assistEvents: 0,
  watchEvents: 0,
  totalVideoClips: 0,
  latestVideoClipAt: null,
  mostCommonEventType: null,
  lastEventAt: null,
  recentEvents: [],
  videoClips: [],
};

async function GETHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const history = await getResidentHistory(id);
    // Ensure recentEvents is always an array even if DB returns unexpected shape
    return NextResponse.json({
      ...EMPTY_HISTORY,
      ...history,
      recentEvents: history.recentEvents ?? [],
    });
  } catch (err) {
    console.error("GET /api/residents/[id]/history error:", err);
    return NextResponse.json({ error: "Failed to load history" }, { status: 500 });
  }
}

export const GET = withAuth(GETHandler);
