"use client";

import DemoVideoTile from "./DemoVideoTile";
import { DEMO_SCENARIOS } from "@/lib/demoScenarios";
import { residentDisplayName } from "@/lib/residentDisplay";
import type { ResidentProfile } from "@/lib/types";

// Row order: Robert / Eleanor, Daniel / Margaret. Keep video and patient IDs paired.
const DISPLAY_ORDER = ["feed2", "feed1", "feed4", "feed3"];

export default function MultiFeedDemo({ runningFeedIds, onToggleFeed, residents }: {
  runningFeedIds: string[];
  onToggleFeed: (id: string) => void;
  residents: ResidentProfile[];
}) {
  const feeds = DISPLAY_ORDER.flatMap(id => {
    const scenario = DEMO_SCENARIOS.find(feed => feed.id === id)!;
    const patient = residents.find(resident => resident.id === scenario.residentId && resident.active !== false);
    return patient ? [{ ...scenario, resident: residentDisplayName(patient.id, patient.name), room: patient.room, risk: `${patient.fallRisk} risk` }] : [];
  });

  return <div className="camera-grid">
    {feeds.map(feed => <DemoVideoTile key={feed.id} config={feed}
      isPaused={!runningFeedIds.includes(feed.id)} onTogglePlayback={() => onToggleFeed(feed.id)} />)}
    {feeds.length < 4 && <p role="alert" className="connection-message">Some residents are unavailable or not assigned to this account.</p>}
  </div>;
}
