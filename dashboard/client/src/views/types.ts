export const DASHBOARD_SECTIONS = [
  { id: 'command', label: 'Command', placement: 'primary' },
  { id: 'monitor', label: 'Monitor', placement: 'primary' },
  { id: 'analytics', label: 'Insights', placement: 'primary' },
  { id: 'knowledge', label: 'Knowledge', placement: 'secondary' },
] as const;

export type DashboardSection = typeof DASHBOARD_SECTIONS[number]['id'];
export type DashboardPanel = 'attention' | 'readiness' | null;

export function isDashboardSection(value: string | null): value is DashboardSection {
  return value !== null && DASHBOARD_SECTIONS.some((section) => section.id === value);
}
