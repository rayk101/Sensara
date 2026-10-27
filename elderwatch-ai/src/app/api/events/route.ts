import { withAuth, ApiError } from "@/lib/platform/auth";
import { NextResponse } from "next/server";
import { getRecentEvents, getEventsByResident } from "@/lib/db/events";
import { submitIncident } from "@/lib/platform/incidents";
export const dynamic = "force-dynamic";

async function GETHandler(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return NextResponse.json({ error: "limit must be an integer between 1 and 200" }, { status: 400 });
  }
  const idsParam = searchParams.get("ids");
  const ids = idsParam === null ? undefined : idsParam === "" ? [] : idsParam.split(",");
  if (ids && (ids.length > 100 || ids.some(id => !/^[a-f\d]{24}$/i.test(id)))) {
    return NextResponse.json({ error: "ids must contain at most 100 valid incident IDs" }, { status: 400 });
  }
  try {
    const residentId = searchParams.get("residentId");
    const events = ids !== undefined
      ? (await getRecentEvents(limit, ids)).filter(event => !residentId || event.residentId === residentId)
      : residentId
      ? await getEventsByResident(residentId, limit)
      : await getRecentEvents(limit);
    return NextResponse.json({ events });
  } catch (err) {
    console.error("GET /api/events error:", err);
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
  }
}

async function POSTHandler(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  if (body.source === "audio_monitor") throw new ApiError(400, "Submit audio through the audio analysis endpoint");
  const event = await submitIncident(body);
  return NextResponse.json(event, { status: 201 });
}
export const GET = withAuth(GETHandler);
export const POST = withAuth(POSTHandler);
