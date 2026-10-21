export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getEventAnalytics } from "@/lib/db/events";
import { isMongoEnabled } from "@/lib/mongodb";

export async function GET() {
  try {
    const analytics = await getEventAnalytics();
    return NextResponse.json({ ...analytics, mongoConnected: isMongoEnabled() });
  } catch (err) {
    console.error("GET /api/analytics error:", err);
    return NextResponse.json({ error: "Failed to fetch analytics" }, { status: 500 });
  }
}
