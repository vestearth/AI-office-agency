import type { DashboardSection } from './views/types';

// Lightweight cross-view navigation + URL state. Views dispatch a window event
// (mirroring the existing 'dashboard:refresh' bus) so they can deep-link into
// Monitor without prop-drilling through App. App owns the listener and the
// query-string sync (?tab=…&run=…) via history.replaceState.

export const NAV_EVENT = 'dashboard:navigate';

export interface NavDetail {
  tab: DashboardSection;
  run: string | null;
}

const SECTIONS: DashboardSection[] = ['command', 'monitor', 'review', 'analytics', 'reports'];

/** Request a tab switch (and optional run selection) from any view. */
export function navigateTo(tab: DashboardSection, run: string | null = null): void {
  window.dispatchEvent(new CustomEvent<NavDetail>(NAV_EVENT, { detail: { tab, run } }));
}

/** Read the initial tab/run from the URL once on load (invalid tab → null). */
export function readUrlState(): { tab: DashboardSection | null; run: string | null } {
  const params = new URLSearchParams(window.location.search);
  const tabRaw = params.get('tab');
  const tab = tabRaw && (SECTIONS as string[]).includes(tabRaw) ? (tabRaw as DashboardSection) : null;
  return { tab, run: params.get('run') };
}

/** Reflect current state into the URL without growing the history stack. */
export function writeUrlState(tab: DashboardSection, run: string | null): void {
  const params = new URLSearchParams(window.location.search);
  params.set('tab', tab);
  if (run) params.set('run', run);
  else params.delete('run');
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', next);
}
