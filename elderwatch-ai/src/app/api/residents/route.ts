import { withAuth } from "@/lib/platform/auth";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getResidents, saveResident } from "@/lib/db/residents";
import { isMongoEnabled } from "@/lib/mongodb";

async function GETHandler() {
  try {
    const residents = await getResidents();
    return NextResponse.json({ residents, mongoConnected: isMongoEnabled() });
  } catch (err) {
    console.error("GET /api/residents error:", err);
    return NextResponse.json({ error: "Failed to fetch residents" }, { status: 500 });
  }
}

export const GET = withAuth(GETHandler);

export const POST = withAuth(async (req: Request) => Response.json(await saveResident(await req.json()), { status: 201 }));
