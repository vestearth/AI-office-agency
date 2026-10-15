export const DASHBOARD_SECTIONS = [
  { id: 'command', label: 'Command', placement: 'primary' },
  { id: 'monitor', label: 'Monitor', placement: 'primary' },
  { id: 'analytics', label: 'Insights', placement: 'primary' },
  { id: 'knowledge', label: 'Knowledge', placement: 'secondary' },
] as const;

/**
 * Tools owned by other teams, linked from the header and opened in a new tab.
 * They are not dashboard sections: no ?tab= state, no in-app rendering (the
 * target sites have their own login, so they cannot be embedded).
 */
export const EXTERNAL_LINKS = [
  {
    id: 'reliability',
    label: 'Reliability',
    href: 'https://aws.upslip.net/reliability',
    title: 'AWS Tracking reliability view by DevOps (repo aws-tracking): API latency, task restarts, errors. Opens in a new tab; sign in with the UpSlip admin account.',
  },
] as const;

export type DashboardSection = typeof DASHBOARD_SECTIONS[number]['id'];
export type DashboardPanel = 'attention' | 'operations' | 'readiness' | 'decisions' | 'audits' | null;

export function isDashboardSection(value: string | null): value is DashboardSection {
  return value !== null && DASHBOARD_SECTIONS.some((section) => section.id === value);
}
