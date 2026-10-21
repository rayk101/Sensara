import { withAuth, requireAdmin } from "@/lib/platform/auth";
import { NextResponse } from "next/server";
import { isPhotonConfigured, photonErrorMessage, sendPhotonMessage } from "@/lib/photon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let sending = false;
let lastSent = 0;

async function POSTHandler() {
  requireAdmin();
  if (!isPhotonConfigured()) {
    return NextResponse.json({ error: "Photon is not configured." }, { status: 503 });
  }
  if (sending || Date.now() - lastSent < 60_000) {
    return NextResponse.json({ error: "Please wait one minute between test messages." }, { status: 429 });
  }
  sending = true;
  try {
    await sendPhotonMessage("Sensara demo: Photon iMessage alerts connected. This is a test.");
    lastSent = Date.now();
    return NextResponse.json({ sent: true });
  } catch (error) {
    return NextResponse.json({ error: photonErrorMessage(error) }, { status: 502 });
  } finally {
    sending = false;
  }
}

export const POST = withAuth(POSTHandler);
