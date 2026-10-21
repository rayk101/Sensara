export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getNotesForEvent, createCaregiverNote } from "@/lib/db/notes";
import { getSafetyEvent } from "@/lib/db/events";
import type { CaregiverNote } from "@/lib/types";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const notes = await getNotesForEvent(id);
    return NextResponse.json({ notes });
  } catch (err) {
    console.error("GET /api/events/[id]/notes error:", err);
    return NextResponse.json({ error: "Failed to fetch notes" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
    const { residentId, note, createdBy } = body;

    if (typeof note !== "string" || !note.trim()) {
      return NextResponse.json({ error: "Note text is required" }, { status: 400 });
    }

    const event = await getSafetyEvent(id);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (residentId && residentId !== event.residentId) return NextResponse.json({ error: "Resident does not match event" }, { status: 400 });
    if (createdBy !== undefined && typeof createdBy !== "string") return NextResponse.json({ error: "Invalid caregiver name" }, { status: 400 });

    const noteDoc: Omit<CaregiverNote, "_id"> = {
      residentId: event.residentId,
      eventId: id,
      note: note.trim(),
      createdBy: createdBy || "Demo Caregiver",
      createdAt: new Date().toISOString(),
    };

    const created = await createCaregiverNote(noteDoc);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    console.error("POST /api/events/[id]/notes error:", err);
    return NextResponse.json({ error: "Failed to create note" }, { status: 500 });
  }
}
