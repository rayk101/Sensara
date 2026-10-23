import type { RecordingStatus } from "@/hooks/useVideoRecorder";

export default function RecordingNotice({ status, message }: { status: RecordingStatus; message: string | null }) {
  if (!message) return null;
  const failed = status === "error" || status === "s3-disabled";
  const colors = status === "saved" ? "bg-green-900 text-green-100 border-green-600"
    : status === "uploading" || status === "preparing" ? "bg-blue-900 text-blue-100 border-blue-600"
    : "bg-red-900 text-red-100 border-red-600";
  return (
    <div role={failed ? "alert" : "status"} aria-live={failed ? "assertive" : "polite"} aria-atomic="true"
      className={`fixed top-20 right-4 z-50 max-w-[calc(100vw-2rem)] sm:max-w-md rounded-xl px-4 py-3 text-sm shadow-xl border flex items-center gap-2 ${colors}`}>
      {(status === "preparing" || status === "uploading") && <span aria-hidden="true" className="shrink-0 w-4 h-4 border-2 border-blue-300/30 border-t-blue-200 rounded-full animate-spin" />}
      {status === "capturing" && <span aria-hidden="true" className="shrink-0 w-2 h-2 rounded-full bg-red-300 animate-pulse" />}
      <span className="break-words min-w-0">{message}</span>
    </div>
  );
}
