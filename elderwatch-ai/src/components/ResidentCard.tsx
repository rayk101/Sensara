"use client";

import SafetyBadge from "./SafetyBadge";
import { POSE_POLICY } from "@/lib/poseEvidence";
import type { ResidentProfile, SafetyClassification, SafetySignals } from "@/lib/types";

interface ResidentCardProps {
  resident: ResidentProfile;
  classification: SafetyClassification;
  signals: SafetySignals;
  monitoringAvailable?: boolean;
  observationAvailable?: boolean;
  residents: ResidentProfile[];
  onSelectResident: (id: string) => void;
}

const FALL_RISK_COLOR = {
  Low: "text-green-400",
  Medium: "text-yellow-400",
  High: "text-red-400",
};

const EVENT_LABELS: Record<string, string> = {
  possible_choking: "Possible Distress / Neck Gesture",
  fall_risk: "Fall Risk",
  possible_fall: "Possible Fall",
  immobility: "Immobility",
  wandering: "Wandering",
  unsafe_posture: "Unsafe Posture",
  out_of_frame: "Out of Frame",
  normal: "Normal",
};

// Pulse border style depending on severity
const PULSE_BORDER: Record<string, string> = {
  stable: "border-sensara-border",
  watch: "border-yellow-500 animate-pulse-watch",
  assist: "border-orange-500 animate-pulse-assist",
  urgent: "border-red-500 animate-pulse-urgent",
};

const BG_TINT: Record<string, string> = {
  stable: "bg-white",
  watch: "bg-yellow-50",
  assist: "bg-orange-50",
  urgent: "bg-red-50",
};

export default function ResidentCard({
  resident,
  classification,
  signals,
  monitoringAvailable = true,
  observationAvailable,
  residents,
  onSelectResident,
}: ResidentCardProps) {
  const available = monitoringAvailable && (observationAvailable ?? signals.visible);
  const { severity, eventType, reason, confidence } = classification;

  return (
    <div
      className={`rounded-xl border-2 p-4 transition-all duration-300 ${available ? PULSE_BORDER[severity] : "border-slate-300"} ${available ? BG_TINT[severity] : "bg-slate-50"}`}
    >
      {/* Resident selector */}
      <div className="flex items-center justify-between mb-3">
        <select
          value={resident.id}
          onChange={(e) => onSelectResident(e.target.value)}
          className="bg-sensara-warm-100 text-sensara-forest-900 text-sm rounded-lg px-3 py-1.5 border border-sensara-border focus:outline-none focus:ring-1 focus:ring-sensara-forest-500 cursor-pointer"
        >
          {residents.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} — {r.room}
            </option>
          ))}
        </select>
        {available ? <SafetyBadge severity={severity} size="md" pulse /> : <span className="text-sm font-semibold text-slate-600">UNKNOWN</span>}
      </div>

      {/* Current event */}
      <div>
        <p className="text-xs text-sensara-warm-600 uppercase tracking-wide mb-1.5">Current camera observation</p>
        <div className="bg-sensara-warm-100 rounded-lg p-3 space-y-1.5 border border-sensara-divider">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-sensara-forest-900">
              {available ? EVENT_LABELS[eventType] ?? eventType : "Monitoring / tracking unavailable"}
            </span>
            <span className="text-xs text-sensara-warm-600">
              {confidence > 0 ? `${Math.round(confidence * 100)}/100 heuristic` : "Movement rule · not a diagnosis"}
            </span>
          </div>
          <p className="text-sm text-sensara-forest-800">{reason}</p>
          {available && signals.visible && <p className="text-xs text-sensara-warm-700">Hanging-arm posture: {signals.bothArmsHanging ? "both arms tracked down" : "both arms not confirmed"} · {(signals.secondsSlumped ?? 0).toFixed(1)}s / {POSE_POLICY.slumpHold}s</p>}

          {/* Pose signal summary */}
          {available && signals.visible && <div className="grid grid-cols-3 gap-1 mt-2 text-[10px] font-mono">
            <SignalPill label="Posture" value={`${Math.round(signals.postureAngle)}°`} warn={signals.postureAngle > 35} danger={signals.postureAngle > 60} />
            <SignalPill label="Still" value={signals.secondsStill > 0 ? `${Math.round(signals.secondsStill)}s` : "Moving"} warn={signals.secondsStill > 60} danger={signals.secondsStill > 300} />
            <SignalPill label="Zone" value={signals.insideSafeZone ? "Safe" : "Outside"} danger={!signals.insideSafeZone} />
          </div>}
        </div>
      </div>


      {/* Profile info */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-3">
        <div>
          <p className="text-xs text-sensara-warm-600 uppercase tracking-wide">Name</p>
          <p className="text-sensara-forest-900 font-semibold">{resident.name}</p>
        </div>
        <div>
          <p className="text-xs text-sensara-warm-600 uppercase tracking-wide">Room</p>
          <p className="text-sensara-forest-900 font-semibold">{resident.room}</p>
        </div>
        <div>
          <p className="text-xs text-sensara-warm-600 uppercase tracking-wide">Age</p>
          <p className="text-sensara-forest-800">{resident.age}</p>
        </div>
        <div>
          <p className="text-xs text-sensara-warm-600 uppercase tracking-wide">Fall Risk</p>
          <p className={`font-semibold ${FALL_RISK_COLOR[resident.fallRisk]}`}>
            {resident.fallRisk}
          </p>
        </div>
        <div className="col-span-2">
          <p className="text-xs text-sensara-warm-600 uppercase tracking-wide">Mobility</p>
          <p className="text-sensara-forest-800">{resident.mobility}</p>
        </div>
        <div className="col-span-2">
          <p className="text-xs text-sensara-warm-600 uppercase tracking-wide">Conditions</p>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {resident.conditions.map((c) => (
              <span key={c} className="text-xs bg-sensara-forest-100 text-sensara-forest-800 border border-sensara-forest-200 rounded-full px-2 py-0.5">
                {c}
              </span>
            ))}
          </div>
        </div>
        <div className="col-span-2">
          <p className="text-xs text-sensara-warm-600 uppercase tracking-wide">Care Notes</p>
          <p className="text-sensara-warm-700 text-sm italic">{resident.careNotes}</p>
        </div>
      </div>

      <hr className="border-sensara-divider mb-3" />

      {/* Mock data disclaimer */}
      <p className="text-[10px] text-sensara-warm-500 mt-3 text-center">
        MOCK DATA ONLY — Not a real resident
      </p>
    </div>
  );
}

function SignalPill({
  label,
  value,
  warn = false,
  danger = false,
}: {
  label: string;
  value: string;
  warn?: boolean;
  danger?: boolean;
}) {
  const color = danger
    ? "bg-red-100 text-red-700 border-red-300"
    : warn
    ? "bg-yellow-100 text-yellow-700 border-yellow-300"
    : "bg-sensara-warm-100 text-sensara-warm-700 border-sensara-border";

  return (
    <div className={`rounded border px-1.5 py-1 text-center ${color}`}>
      <div className="text-gray-500 mb-0.5">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}
