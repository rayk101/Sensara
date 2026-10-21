import { withAuth, currentActor } from "@/lib/platform/auth";
import { NextResponse } from "next/server";
import { acknowledgeEvent } from "@/lib/db/events";

async function PATCHHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const acknowledgedBy = currentActor().name;
    const updated = await acknowledgeEvent(id, acknowledgedBy);
    if (!updated) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }
    return NextResponse.json(updated);
  } catch (err) {
    console.error("PATCH /api/events/[id]/acknowledge error:", err);
    return NextResponse.json({ error: "Failed to acknowledge event" }, { status: 500 });
  }
}

export const PATCH = withAuth(PATCHHandler);
