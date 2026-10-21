import { NextResponse } from "next/server";
import { acknowledgeEvent } from "@/lib/db/events";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const acknowledgedBy = body?.acknowledgedBy ?? "Demo Caregiver";
    if (typeof acknowledgedBy !== "string" || !acknowledgedBy.trim()) return NextResponse.json({ error: "Invalid caregiver name" }, { status: 400 });
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
