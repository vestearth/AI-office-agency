import { useEffect } from 'react';

// Shared by the dashboard views. App.tsx bridges the SSE 'runs.changed' stream to
// a window 'dashboard:refresh' event; this re-runs `callback` on each one so a
// view refetches its data live. (Views that need the event detail — e.g. Command
// for incremental loads — keep their own listener.)
export function useDashboardRefresh(callback: () => void) {
  useEffect(() => {
    window.addEventListener('dashboard:refresh', callback);
    return () => window.removeEventListener('dashboard:refresh', callback);
  }, [callback]);
}
