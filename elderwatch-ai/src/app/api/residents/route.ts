export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getResidents } from "@/lib/db/residents";
import { isMongoEnabled } from "@/lib/mongodb";

export async function GET() {
  try {
    const residents = await getResidents();
    return NextResponse.json({ residents, mongoConnected: isMongoEnabled() });
  } catch (err) {
    console.error("GET /api/residents error:", err);
    return NextResponse.json({ error: "Failed to fetch residents" }, { status: 500 });
  }
}
