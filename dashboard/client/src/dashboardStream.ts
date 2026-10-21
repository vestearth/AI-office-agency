const EVENT = 'dashboard:stream';

/** `connecting` until the first SSE open or error. A later close is `closed`, not still connecting. */
export type StreamPhase = 'connecting' | 'open' | 'closed';

let phase: StreamPhase = 'connecting';

/** Latest SSE state. The office view mounts after `onopen`, so it has to read this instead of waiting for the next event. */
export function readDashboardStream(): StreamPhase {
  return phase;
}

export function publishDashboardStream(next: boolean): void {
  phase = next ? 'open' : 'closed';
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { open: next } }));
}

export function subscribeDashboardStream(listener: (phase: StreamPhase) => void): () => void {
  const onStream = (event: Event) => {
    const next = (event as CustomEvent<{ open?: boolean }>).detail?.open === true;
    phase = next ? 'open' : 'closed';
    listener(phase);
  };
  window.addEventListener(EVENT, onStream);
  return () => window.removeEventListener(EVENT, onStream);
}
