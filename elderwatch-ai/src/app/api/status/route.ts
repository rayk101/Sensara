import { withAuth } from "@/lib/platform/auth";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { isMongoEnabled, getDb } from "@/lib/mongodb";
import { isS3Configured } from "@/lib/s3";
import { isSmsConfigured } from "@/lib/sms";
import { isPhotonConfigured } from "@/lib/photon";
import { isEmailAlertsConfigured } from "@/lib/emailAlerts";

// GET /api/status
// Returns actual connectivity state: pings MongoDB and checks S3 env vars.
// Used by the dashboard header indicators on mount.
async function GETHandler() {
  let mongoConnected = false;

  if (isMongoEnabled()) {
    try {
      const db = await getDb();
      await db.command({ ping: 1 }, { timeoutMS: 3000 });
      mongoConnected = true;
    } catch {
      mongoConnected = false;
    }
  }

  return NextResponse.json({
    mongoConnected,
    s3Configured: isS3Configured(),
    smsConfigured: isSmsConfigured(),
    photonConfigured: isPhotonConfigured(),
    emailConfigured: isEmailAlertsConfigured(),
    demoMode: !isMongoEnabled(),
  });
}

export const GET = withAuth(GETHandler);
