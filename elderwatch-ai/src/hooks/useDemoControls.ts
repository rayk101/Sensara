"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/** Explicit starts authorize only the selected feeds. Hidden demos stay paused. */
export function useDemoControls(feedIds: string[], enabled: boolean) {
  const [requestedIds, setRequestedIds] = useState<string[]>([]);
  useEffect(() => {
    setRequestedIds(ids => enabled ? ids.filter(id => feedIds.includes(id)) : []);
  }, [enabled, feedIds]);

  const runningFeedIds = useMemo(
    () => enabled ? requestedIds.filter(id => feedIds.includes(id)) : [],
    [enabled, requestedIds, feedIds],
  );
  const startAll = useCallback(() => {
    if (enabled) setRequestedIds([...feedIds]);
  }, [enabled, feedIds]);
  const pauseAll = useCallback(() => setRequestedIds([]), []);
  const toggleFeed = useCallback((id: string) => {
    if (!enabled || !feedIds.includes(id)) return;
    setRequestedIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
  }, [enabled, feedIds]);

  return {
    runningFeedIds, startAll, pauseAll, toggleFeed,
    allRunning: feedIds.length > 0 && runningFeedIds.length === feedIds.length,
    anyRunning: runningFeedIds.length > 0,
  };
}
