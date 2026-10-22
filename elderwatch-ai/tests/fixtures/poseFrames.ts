import type { PoseFrame } from "../../src/lib/poseEvidence";
import type { PoseLandmark } from "../../src/lib/types";
export function pose(kind: "upright" | "lean" | "fallen" | "neck" | "outside" = "upright"): PoseLandmark[] {
  const points = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: 1 }));
  const center = kind === "outside" ? .96 : .5;
  points[0] = { ...points[0], x: center, y: .15 };
  points[11] = { ...points[11], x: center - .07, y: .3 };
  points[12] = { ...points[12], x: center + .07, y: .3 };
  points[23] = { ...points[23], x: center - .05, y: .6 };
  points[24] = { ...points[24], x: center + .05, y: .6 };
  for (const i of [15, 16, 19, 20]) points[i] = { ...points[i], x: center + (i % 2 ? -.12 : .12), y: kind === "neck" ? .23 : .62 };
  if (kind === "neck") for (const i of [15, 16, 19, 20]) points[i].x = center + (i % 2 ? -.03 : .03);
  if (kind === "lean" || kind === "fallen") {
    const y = kind === "fallen" ? .65 : .4;
    points[11] = { ...points[11], x: .28, y };
    points[12] = { ...points[12], x: .38, y };
  }
  return points;
}
export function measuredScenario(index: number): PoseFrame[] {
  return Array.from({ length: 31 }, (_, i) => ({ time: i * .2, landmarks: pose(index === 0 ? (i < 15 ? "upright" : "fallen") : index === 1 ? "upright" : index === 2 ? "outside" : "neck") }));
}
