import { isDashboardSection, type DashboardPanel, type DashboardSection } from './views/types';

// Lightweight cross-view navigation + URL state. Views dispatch a window event
// (mirroring the existing 'dashboard:refresh' bus) so they can deep-link into
// Monitor without prop-drilling through App. App owns the listener and the
// query-string sync (?tab=…&run=…) via history.replaceState.

export const NAV_EVENT = 'dashboard:navigate';

export interface NavDetail {
  tab: DashboardSection;
  run: string | null;
  panel: DashboardPanel;
}

const LEGACY_TABS: Record<string, { tab: DashboardSection; panel: DashboardPanel }> = {
  review: { tab: 'command', panel: 'attention' },
  reports: { tab: 'analytics', panel: 'readiness' },
};

/** Command opens on Attention: what needs a human comes before the office map. */
export function defaultPanel(tab: DashboardSection): DashboardPanel {
  return tab === 'command' ? 'attention' : null;
}

function normalizePanel(tab: DashboardSection, panel: string | null): DashboardPanel {
  if (tab === 'command' && panel === 'operations') return 'operations';
  if (tab === 'analytics' && panel === 'readiness') return 'readiness';
  return defaultPanel(tab);
}

/** Request a tab switch (and optional run selection) from any view. */
export function navigateTo(
  tab: DashboardSection,
  run: string | null = null,
  panel: DashboardPanel = null,
): void {
  const detail = { tab, run, panel: normalizePanel(tab, panel) };
  window.dispatchEvent(new CustomEvent<NavDetail>(NAV_EVENT, { detail }));
}

export function parseUrlState(search: string): {
  tab: DashboardSection | null;
  run: string | null;
  panel: DashboardPanel;
} {
  const params = new URLSearchParams(search);
  const tabRaw = params.get('tab');
  const legacy = tabRaw ? LEGACY_TABS[tabRaw] : undefined;
  if (legacy) {
    return { ...legacy, run: params.get('run') };
  }

  const tab = isDashboardSection(tabRaw) ? tabRaw : null;
  const run = params.get('run');
  const view = params.get('view');
  // Before Attention became the default, ?tab=command&run=<id> opened the task
  // modal in Operations; keep those links working.
  if (tab === 'command' && run && view === null) {
    return { tab, run, panel: 'operations' };
  }
  return {
    tab,
    run,
    panel: tab ? normalizePanel(tab, view) : null,
  };
}

/** Read the initial tab/run from the URL once on load (invalid tab → null). */
export function readUrlState(): ReturnType<typeof parseUrlState> {
  return parseUrlState(window.location.search);
}

/** Reflect current state into the URL without growing the history stack. */
export function writeUrlState(tab: DashboardSection, run: string | null, panel: DashboardPanel = null): void {
  const params = new URLSearchParams(window.location.search);
  params.set('tab', tab);
  if (run) params.set('run', run);
  else params.delete('run');
  const normalizedPanel = normalizePanel(tab, panel);
  if (normalizedPanel) params.set('view', normalizedPanel);
  else params.delete('view');
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', next);
}
