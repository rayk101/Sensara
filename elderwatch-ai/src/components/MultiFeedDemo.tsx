"use client";

import DemoVideoTile from "./DemoVideoTile";
import { DEMO_SCENARIOS } from "@/lib/demoScenarios";
import type { ResidentProfile } from "@/lib/types";

// Display labels only; keep the existing video order and monitoring identities.
const DISPLAY_ORDER = [
  { id: "feed2", name: "Eleanor Brooks" },
  { id: "feed1", name: "Robert Hayes" },
  { id: "feed4", name: "Margaret Chan" },
  { id: "feed3", name: "Daniel Price" },
];

export default function MultiFeedDemo({ runningFeedIds, onToggleFeed, onIncident, residents }: {
  runningFeedIds: string[];
  onToggleFeed: (id: string) => void;
  onIncident: (feedId: string, eventId: string | null) => void;
  residents: ResidentProfile[];
}) {
  const feeds = DISPLAY_ORDER.flatMap(({ id, name }) => {
    const scenario = DEMO_SCENARIOS.find(feed => feed.id === id)!;
    const patient = residents.find(resident => resident.id === scenario.residentId && resident.active !== false);
    return patient ? [{ ...scenario, resident: name, room: patient.room, risk: `${patient.fallRisk} risk` }] : [];
  });

  return <div className="camera-grid">
    {feeds.map(feed => <DemoVideoTile key={feed.id} config={feed}
      isPaused={!runningFeedIds.includes(feed.id)} onTogglePlayback={() => onToggleFeed(feed.id)} onIncident={onIncident} />)}
    {feeds.length < 4 && <p role="alert" className="connection-message">Some residents are unavailable or not assigned to this account.</p>}
  </div>;
}
