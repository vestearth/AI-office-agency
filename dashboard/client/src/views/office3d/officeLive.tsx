import React, { useEffect, useState } from 'react';
import { readDashboardStream, subscribeDashboardStream, type StreamPhase } from '../../dashboardStream';
import { liveColor, liveWord, updatedLabel } from './officeRoomStats';

/** Keeps "Updated Xm ago" moving. It does not decide LIVE versus STALE. */
const TICK_MS = 15_000;

export function OfficeLiveBadge({ failed, loadedAt }: { failed: boolean; loadedAt: string | null }) {
  const [phase, setPhase] = useState<StreamPhase>(() => readDashboardStream());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeDashboardStream(setPhase), []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="o3d-live" style={{ color: liveColor(phase, failed) }}>
      {liveWord(phase, failed)} · {updatedLabel(loadedAt, now)}
    </p>
  );
}
