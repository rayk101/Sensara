import { withAuth } from "@/lib/platform/auth";
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { isEmailAlertsConfigured } from "@/lib/emailAlerts";

// POST /api/email-alerts/test
// Sends a test email to the configured caregiver address.
async function POSTHandler() {
  if (!isEmailAlertsConfigured()) {
    return NextResponse.json(
      { error: "Email alerts not configured. Set RESEND_API_KEY, CAREGIVER_EMAIL, and ALERT_FROM_EMAIL." },
      { status: 400 }
    );
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY!);
    const { data, error } = await resend.emails.send({
      from: process.env.ALERT_FROM_EMAIL!,
      to: process.env.CAREGIVER_EMAIL!,
      subject: "ElderWatch test alert",
      html: "<p>Email caregiver alert integration is working.</p>",
    });

    if (error) {
      console.error("[Email] Test send Resend error:", error);
      return NextResponse.json({ error: error.message ?? "Resend API error" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, message: "Test email sent.", id: data?.id });
  } catch (err) {
    console.error("[Email] Test send failed:", err);
    return NextResponse.json({ error: "Failed to send test email." }, { status: 500 });
  }
}

export const POST = withAuth(POSTHandler);
