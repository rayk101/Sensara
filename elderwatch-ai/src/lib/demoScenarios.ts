export const DEMO_SCENARIOS = [
  { id: "feed1", residentId: "resident_001", videoFile: "fall-demo.mp4", risk: "High fall risk" },
  { id: "feed2", residentId: "resident_002", videoFile: "stable-demo.mp4", risk: "Post-surgery mobility" },
  { id: "feed3", residentId: "resident_003", videoFile: "wandering-demo.mp4", risk: "Wandering / Memory care" },
  { id: "feed4", residentId: "demo_resident_004", videoFile: "choking-demo.mp4", risk: "Medium risk" },
] as const;
