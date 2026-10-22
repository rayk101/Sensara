"use client";

import { useEffect, useRef, useCallback } from "react";
import { POSE_CONNECTIONS, LM, clampSafeZone } from "@/lib/poseHelpers";
import type { PoseLandmark, SafeZone, ResidentStatusValue } from "@/lib/types";
import type { PoseStatus } from "@/hooks/usePoseDetection";

// ─────────────────────────────────────────────────────────────────────────────
// PoseCamera — Renders video + skeleton overlay on a canvas, plus the safe zone
// rectangle and a live status chip in the corner.
//
// When editMode is true the user can drag corner handles or the whole safe zone
// box directly on the canvas. Normalized (0-1) coordinates are reported back
// via onSafeZoneChange.
// ─────────────────────────────────────────────────────────────────────────────

interface PoseCameraProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  landmarks: PoseLandmark[] | null;
  status: PoseStatus;
  errorMessage: string | null;
  safeZone: SafeZone;
  severity: ResidentStatusValue;
  observationAvailable?: boolean;
  onRetry?: () => void;
  /** When true the user can drag the safe zone on the canvas */
  editMode?: boolean;
  /** Called with updated zone coordinates while the user drags */
  onSafeZoneChange?: (zone: SafeZone) => void;
  /** Used to show the subtle "Outside zone…" indicator */
  insideSafeZone?: boolean;
}

// "left"/"right" refer to display-left and display-right (the mirrored view).
// Because the video is horizontally flipped, display-left = raw right edge of the zone.
type DragHandle = "left" | "right" | "move";

interface DragState {
  handle: DragHandle;
  startNX: number;  // pointer x in normalized display coords at drag start
  startNY: number;
  startZone: SafeZone;
}

const SEVERITY_COLORS: Record<ResidentStatusValue, string> = {
  stable: "#22c55e",
  watch: "#eab308",
  assist: "#f97316",
  urgent: "#ef4444",
};

const SKELETON_COLOR = "#60a5fa"; // blue-400
const JOINT_COLOR = "#93c5fd";    // blue-300
const SAFE_ZONE_COLOR = "rgba(34, 197, 94, 0.25)";
const SAFE_ZONE_BORDER = "#22c55e";
const SAFE_ZONE_EDIT_BORDER = "#86efac"; // brighter green in edit mode
const HANDLE_HIT_NORM = 0.045; // normalized hit-test radius for edge handles

export default function PoseCamera({
  videoRef,
  canvasRef,
  landmarks,
  status,
  errorMessage,
  safeZone,
  severity,
  observationAvailable = true,
  onRetry,
  editMode = false,
  onSafeZoneChange,
  insideSafeZone = true,
}: PoseCameraProps) {
  const drawingRef = useRef<number>(0);
  const dragRef = useRef<DragState | null>(null);

  // Keep a ref to the latest safeZone so the drawing loop always uses current values
  // without being recreated on every prop change.
  const safeZoneRef = useRef(safeZone);
  const editModeRef = useRef(editMode);
  const insideSafeZoneRef = useRef(insideSafeZone);
  useEffect(() => { safeZoneRef.current = safeZone; }, [safeZone]);
  useEffect(() => { editModeRef.current = editMode; }, [editMode]);
  useEffect(() => { insideSafeZoneRef.current = insideSafeZone; }, [insideSafeZone]);

  // ── Convert canvas CSS pointer coords → normalized (0-1) ─────────────────────
  const toNormalized = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { nx: 0, ny: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      nx: (clientX - rect.left) / rect.width,
      ny: (clientY - rect.top) / rect.height,
    };
  }, [canvasRef]);

  // ── Pointer down: hit-test left/right edge handles then interior ──────────────
  // nx is in display (mirrored) coordinates: 0=left edge of canvas, 1=right.
  // Display-left edge = 1 - (sz.x + sz.width), display-right edge = 1 - sz.x.
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editMode || !onSafeZoneChange) return;
    e.preventDefault();
    const { nx, ny } = toNormalized(e.clientX, e.clientY);
    const z = safeZoneRef.current;

    const displayLeft  = 1 - z.x - z.width;
    const displayRight = 1 - z.x;

    if (Math.abs(nx - displayLeft) < HANDLE_HIT_NORM) {
      dragRef.current = { handle: "left", startNX: nx, startNY: ny, startZone: { ...z } };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (Math.abs(nx - displayRight) < HANDLE_HIT_NORM) {
      dragRef.current = { handle: "right", startNX: nx, startNY: ny, startZone: { ...z } };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (nx > displayLeft && nx < displayRight) {
      dragRef.current = { handle: "move", startNX: nx, startNY: ny, startZone: { ...z } };
      (e.target as Element).setPointerCapture(e.pointerId);
    }
  }, [editMode, onSafeZoneChange, toNormalized]);

  // ── Pointer move: update safe zone while dragging ─────────────────────────────
  // dx is in display coordinates. Because the video is mirrored:
  //   display-left  edge = 1 - (sz.x + sz.width)  → dragging right shrinks width
  //   display-right edge = 1 - sz.x               → dragging right decreases sz.x (zone shifts left in raw)
  //   move                                         → dragging right shifts zone left in raw (sz.x decreases)
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || !onSafeZoneChange) return;

    const { nx } = toNormalized(e.clientX, e.clientY);
    const dx = nx - drag.startNX;  // positive = moved right in display
    const s = drag.startZone;
    const z = { ...s };

    switch (drag.handle) {
      case "left":  z.width = s.width - dx; break;                          // display-left = raw right boundary
      case "right": z.x = s.x - dx; z.width = s.width + dx; break;         // display-right = raw left boundary
      case "move":  z.x = s.x - dx; break;                                  // shift whole zone
    }

    onSafeZoneChange(clampSafeZone(z));
  }, [onSafeZoneChange, toNormalized]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // ── Canvas drawing loop ───────────────────────────────────────────────────────
  useEffect(() => {
    function draw() {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video || video.readyState < 2) {
        drawingRef.current = requestAnimationFrame(draw);
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        drawingRef.current = requestAnimationFrame(draw);
        return;
      }

      // Match canvas dimensions to actual video
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
      }

      const W = canvas.width;
      const H = canvas.height;
      const sz = safeZoneRef.current;
      const inEdit = editModeRef.current;
      const inZone = insideSafeZoneRef.current;

      // 1. Draw mirrored video frame
      ctx.save();
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, W, H);
      ctx.restore();

      // 2. Draw safe zone — two vertical lines spanning full height.
      // The zone is stored in raw landmark coords but the video is mirrored, so we
      // flip x: display-left = 1 - (sz.x + sz.width), display-right = 1 - sz.x.
      const dLeft  = (1 - sz.x - sz.width) * W;
      const dRight = (1 - sz.x) * W;

      // Semi-transparent fill between the lines
      ctx.fillStyle = inEdit ? "rgba(34, 197, 94, 0.08)" : SAFE_ZONE_COLOR;
      ctx.fillRect(dLeft, 0, dRight - dLeft, H);

      // Vertical boundary lines
      ctx.strokeStyle = inEdit ? SAFE_ZONE_EDIT_BORDER : SAFE_ZONE_BORDER;
      ctx.lineWidth = inEdit ? 2.5 : 2;
      ctx.setLineDash([8, 4]);
      ctx.beginPath(); ctx.moveTo(dLeft,  0); ctx.lineTo(dLeft,  H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(dRight, 0); ctx.lineTo(dRight, H); ctx.stroke();
      ctx.setLineDash([]);

      // Label at top-centre of zone
      ctx.font = "bold 11px monospace";
      const midX = (dLeft + dRight) / 2;
      if (inEdit) {
        ctx.fillStyle = SAFE_ZONE_EDIT_BORDER;
        ctx.fillText("← drag edges →", midX - 48, 16);
      } else if (!inZone) {
        ctx.fillStyle = "rgba(234, 179, 8, 0.9)";
        ctx.fillText("Outside zone…", dLeft + 6, 16);
      } else {
        ctx.fillStyle = SAFE_ZONE_BORDER;
        ctx.fillText("SAFE ZONE", midX - 30, 16);
      }

      // 3. Draw side-edge handles in edit mode
      if (inEdit) {
        const HW = 10;   // handle width px
        const HH = 52;   // handle height px
        const midY = H / 2;
        ctx.setLineDash([]);
        for (const ex of [dLeft, dRight]) {
          ctx.fillStyle = "rgba(255,255,255,0.92)";
          ctx.fillRect(ex - HW / 2, midY - HH / 2, HW, HH);
          ctx.strokeStyle = SAFE_ZONE_EDIT_BORDER;
          ctx.lineWidth = 2;
          ctx.strokeRect(ex - HW / 2, midY - HH / 2, HW, HH);
        }
      }

      // 4. Draw skeleton if landmarks are available
      if (landmarks && landmarks.length > 0) {
        // Mirror landmark X coordinates to match the flipped video
        const mirrorX = (x: number) => 1 - x;

        // Draw bone connections
        ctx.strokeStyle = SKELETON_COLOR;
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.setLineDash([]);
        for (const [a, b] of POSE_CONNECTIONS) {
          const lmA = landmarks[a];
          const lmB = landmarks[b];
          if (!lmA || !lmB) continue;
          if (
            (lmA.visibility !== undefined && lmA.visibility < 0.3) ||
            (lmB.visibility !== undefined && lmB.visibility < 0.3)
          ) continue;

          ctx.beginPath();
          ctx.moveTo(mirrorX(lmA.x) * W, lmA.y * H);
          ctx.lineTo(mirrorX(lmB.x) * W, lmB.y * H);
          ctx.stroke();
        }

        // Draw joints
        for (let i = 0; i < landmarks.length; i++) {
          const lm = landmarks[i];
          if (!lm) continue;
          if (lm.visibility !== undefined && lm.visibility < 0.3) continue;
          ctx.beginPath();
          ctx.arc(mirrorX(lm.x) * W, lm.y * H, 4, 0, 2 * Math.PI);
          ctx.fillStyle = JOINT_COLOR;
          ctx.fill();
          ctx.strokeStyle = "#1e40af";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Choking detection overlay: throat marker + hand proximity rings
        const nose = landmarks[LM.NOSE];
        const lShoulder = landmarks[LM.LEFT_SHOULDER];
        const rShoulder = landmarks[LM.RIGHT_SHOULDER];
        if (nose && lShoulder && rShoulder &&
            (nose.visibility === undefined || nose.visibility > 0.3)) {
          const shoulderMidX = (lShoulder.x + rShoulder.x) / 2;
          const shoulderMidY = (lShoulder.y + rShoulder.y) / 2;
          const throatNX = shoulderMidX + 0.65 * (nose.x - shoulderMidX);
          const throatNY = shoulderMidY + 0.65 * (nose.y - shoulderMidY);
          const txC = mirrorX(throatNX) * W;
          const tyC = throatNY * H;
          const HAND_DIST = 0.16;
          const dist2 = (lm: { x: number; y: number }) =>
            Math.sqrt((lm.x - throatNX) ** 2 + (lm.y - throatNY) ** 2);

          // Check which hand landmarks are near throat (mirror X doesn't affect distance)
          const handLMs = [
            { lm: landmarks[LM.LEFT_WRIST],  color: "rgba(239,68,68,0.9)" },
            { lm: landmarks[LM.LEFT_INDEX],  color: "rgba(239,68,68,0.9)" },
            { lm: landmarks[LM.RIGHT_WRIST], color: "rgba(249,115,22,0.9)" },
            { lm: landmarks[LM.RIGHT_INDEX], color: "rgba(249,115,22,0.9)" },
          ];

          let anyNear = false;
          for (const { lm: handLm, color } of handLMs) {
            if (!handLm || (handLm.visibility !== undefined && handLm.visibility < 0.3)) continue;
            if (dist2(handLm) < HAND_DIST) {
              anyNear = true;
              ctx.beginPath();
              ctx.arc(mirrorX(handLm.x) * W, handLm.y * H, 11, 0, 2 * Math.PI);
              ctx.strokeStyle = color;
              ctx.lineWidth = 2.5;
              ctx.stroke();
            }
          }

          // Throat dot: yellow when idle, red when hands near
          ctx.beginPath();
          ctx.arc(txC, tyC, 6, 0, 2 * Math.PI);
          ctx.fillStyle = anyNear ? "rgba(239,68,68,0.85)" : "rgba(234,179,8,0.55)";
          ctx.fill();
          ctx.strokeStyle = anyNear ? "#ef4444" : "#eab308";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // 5. Severity status chip (top-left)
      const chipColor = observationAvailable && status === "running" ? SEVERITY_COLORS[severity] : "#94a3b8";
      const chipLabel = observationAvailable && status === "running" ? (severity === "watch" ? "WATCHING" : severity.toUpperCase()) : "UNKNOWN";
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(8, 8, 110, 28, 6);
      else ctx.rect(8, 8, 110, 28);
      ctx.fill();
      ctx.fillStyle = chipColor;
      ctx.font = "bold 13px monospace";
      ctx.fillText(`● ${chipLabel}`, 16, 27);

      drawingRef.current = requestAnimationFrame(draw);
    }

    drawingRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(drawingRef.current);
    // landmarks/safeZone/severity are read via refs so this effect only needs
    // to restart when the canvas/video refs change (which never happens).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landmarks, safeZone, severity, observationAvailable, status, editMode, insideSafeZone, videoRef, canvasRef]);

  // ── Status overlay messages ────────────────────────────────────────────────
  const overlayContent = (() => {
    if (status === "loading") {
      return (
        <div className="absolute bottom-3 left-3 right-3 flex items-center gap-3 rounded-lg bg-gray-900/80 p-3 text-white">
          <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-300">{errorMessage || "Starting camera and local body tracking…"}</p>
          {errorMessage && onRetry && <button onClick={onRetry}>Retry camera</button>}
        </div>
      );
    }
    if (status === "no-webcam" || status === "error") {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/90 text-white gap-3 px-6 text-center">
          <svg className="w-12 h-12 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.893L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
          </svg>
          <p className="text-sm text-red-300">{errorMessage || "Camera unavailable"}</p>
          <p className="text-xs text-gray-400">Monitoring unavailable. Saved incidents remain active.</p>
          {onRetry && <button onClick={onRetry} className="rounded bg-white px-3 py-2 text-sm text-slate-900">Retry camera</button>}
        </div>
      );
    }
    if (status === "idle") {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900/70">
          <p className="text-gray-400 text-sm">Camera inactive</p>
        </div>
      );
    }
    return null;
  })();

  return (
    <div className="relative w-full rounded-xl overflow-hidden bg-gray-900 border border-gray-700">
      {/* Hidden video element — feed for MediaPipe */}
      <video
        ref={videoRef}
        className="hidden"
        playsInline
        muted
        autoPlay
      />

      {/* Canvas — shows mirrored video + skeleton overlay + safe zone handles */}
      <canvas
        ref={canvasRef}
        className="w-full h-auto block"
        style={{
          aspectRatio: "4/3",
          background: "#111827",
          cursor: editMode ? "crosshair" : "default",
        }}
        onPointerDown={editMode ? handlePointerDown : undefined}
        onPointerMove={editMode ? handlePointerMove : undefined}
        onPointerUp={editMode ? handlePointerUp : undefined}
        onPointerLeave={editMode ? handlePointerUp : undefined}
      />

      {/* Status overlay (loading / error) */}
      {overlayContent}

      {/* Legend */}
      <div className="absolute bottom-2 right-2 flex flex-col gap-1 bg-black/50 rounded-lg px-2 py-1.5 text-[10px] text-gray-300">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-0.5 bg-blue-400" />
          <span>Skeleton</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-0.5 bg-green-500 border-dashed" />
          <span>Safe Zone</span>
        </div>
        {editMode && (
          <div className="flex items-center gap-1.5 text-green-300">
            <span>✎</span>
            <span>Editing</span>
          </div>
        )}
      </div>
    </div>
  );
}
