"use client";

import type { ResidentStatusValue } from "@/lib/types";

interface SafetyBadgeProps {
  severity: ResidentStatusValue;
  size?: "sm" | "md" | "lg";
  pulse?: boolean;
}

const CONFIGS: Record<ResidentStatusValue, { label: string; bg: string; text: string; border: string; dot: string }> = {
  stable: {
    label: "STABLE",
    bg: "bg-green-950/60",
    text: "text-green-300",
    border: "border-green-700",
    dot: "bg-green-400",
  },
  watch: {
    label: "WATCHING",
    bg: "bg-yellow-950/60",
    text: "text-yellow-300",
    border: "border-yellow-600",
    dot: "bg-yellow-400",
  },
  assist: {
    label: "ASSIST",
    bg: "bg-orange-950/60",
    text: "text-orange-300",
    border: "border-orange-600",
    dot: "bg-orange-400",
  },
  urgent: {
    label: "URGENT",
    bg: "bg-red-950/60",
    text: "text-red-300",
    border: "border-red-600",
    dot: "bg-red-400",
  },
};

const SIZE: Record<string, { badge: string; dot: string; text: string }> = {
  sm: { badge: "px-2 py-0.5 gap-1.5", dot: "w-1.5 h-1.5", text: "text-xs" },
  md: { badge: "px-3 py-1 gap-2", dot: "w-2 h-2", text: "text-sm font-bold" },
  lg: { badge: "px-4 py-1.5 gap-2.5", dot: "w-2.5 h-2.5", text: "text-base font-bold" },
};

const PULSE: Record<ResidentStatusValue, string> = {
  stable: "",
  watch: "animate-pulse-watch",
  assist: "animate-pulse-assist",
  urgent: "animate-pulse-urgent",
};

export default function SafetyBadge({ severity, size = "md", pulse = false }: SafetyBadgeProps) {
  const cfg = CONFIGS[severity];
  const sz = SIZE[size];

  return (
    <span
      className={`inline-flex items-center rounded-full border font-mono tracking-wider
        ${cfg.bg} ${cfg.text} ${cfg.border} ${sz.badge} ${sz.text}
        ${pulse && severity !== "stable" ? PULSE[severity] : ""}`}
    >
      <span className={`rounded-full shrink-0 ${cfg.dot} ${sz.dot} ${pulse && severity !== "stable" ? "animate-pulse" : ""}`} />
      {cfg.label}
    </span>
  );
}
