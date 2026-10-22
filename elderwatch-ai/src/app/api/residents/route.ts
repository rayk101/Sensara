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
    console.error("Patient database unavailable", { name: err instanceof Error ? err.name : "UnknownError", code: (err as { code?: string })?.code });
    return NextResponse.json({ error: "The patient database is temporarily unreachable. Please retry in a moment." }, { status: 503 });
  }
}

export const GET = withAuth(GETHandler);

export const POST = withAuth(async (req: Request) => Response.json(await saveResident(await req.json()), { status: 201 }));
