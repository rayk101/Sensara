import { withAuth } from "@/lib/platform/auth";
import { NextResponse } from "next/server";
import { isSmsConfigured } from "@/lib/sms";

// POST /api/sms/test
// Sends a test SMS to CAREGIVER_PHONE_NUMBER to verify Twilio credentials.
async function POSTHandler() {
  if (!isSmsConfigured()) {
    return NextResponse.json(
      { error: "SMS not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, and CAREGIVER_PHONE_NUMBER." },
      { status: 503 }
    );
  }

  try {
    const twilio = (await import("twilio")).default;
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!
    );

    await client.messages.create({
      body: "Sensara test alert: SMS integration is working.",
      from: process.env.TWILIO_PHONE_NUMBER!,
      to:   process.env.CAREGIVER_PHONE_NUMBER!,
    });

    return NextResponse.json({ ok: true, message: "Test SMS sent." });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[SMS] Test send failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);
