import { describe, expect, it } from 'vitest';
import { defaultPanel, parseAttentionKind, parseUrlState } from './navigation';
import { DASHBOARD_SECTIONS, EXTERNAL_LINKS } from './views/types';

describe('parseUrlState', () => {
  it('restores every current top-level section', () => {
    for (const { id } of DASHBOARD_SECTIONS) {
      expect(parseUrlState(`?tab=${id}`)).toEqual({ tab: id, run: null, panel: defaultPanel(id) });
    }
  });

  it('no longer restores the retired intake tab', () => {
    // The Intake Board was removed on 2026-08-13 (6a1abde3); an old ?tab=intake
    // link falls back to the default section instead of a tab that no longer exists.
    expect(parseUrlState('?tab=intake')).toEqual({ tab: null, run: null, panel: null });
  });

  it('preserves old Action and Reports links through consolidated panels', () => {
    expect(parseUrlState('?tab=review&run=TASK-EAR-155')).toEqual({
      tab: 'command',
      run: 'TASK-EAR-155',
      panel: 'attention',
    });
    expect(parseUrlState('?tab=reports')).toEqual({ tab: 'analytics', run: null, panel: 'readiness' });
  });

  it('rejects unknown sections and invalid panel combinations', () => {
    expect(parseUrlState('?tab=unknown&view=attention')).toEqual({ tab: null, run: null, panel: null });
    expect(parseUrlState('?tab=monitor&view=attention')).toEqual({ tab: 'monitor', run: null, panel: null });
  });
});

describe('Command defaults to the Attention panel', () => {
  it('opens Attention when a Command link names no view', () => {
    expect(parseUrlState('?tab=command')).toEqual({ tab: 'command', run: null, panel: 'attention' });
    expect(parseUrlState('?tab=command&view=bogus')).toEqual({ tab: 'command', run: null, panel: 'attention' });
  });

  it('still opens the task modal for an older ?tab=command&run= link with no view', () => {
    expect(parseUrlState('?tab=command&run=TASK-EAR-1')).toEqual({ tab: 'command', run: 'TASK-EAR-1', panel: 'operations' });
    expect(parseUrlState('?tab=command&run=TASK-EAR-1&view=attention')).toEqual({ tab: 'command', run: 'TASK-EAR-1', panel: 'attention' });
  });

  it('keeps the Operations map reachable as an explicit view', () => {
    expect(parseUrlState('?tab=command&view=operations')).toEqual({ tab: 'command', run: null, panel: 'operations' });
  });

  it('gives only Command a default panel', () => {
    expect(defaultPanel('command')).toBe('attention');
    expect(defaultPanel('monitor')).toBeNull();
    expect(defaultPanel('analytics')).toBeNull();
  });
});

describe('Attention filter in the URL', () => {
  it('reads kind only on the Attention panel', () => {
    expect(parseAttentionKind('?tab=command&view=attention&kind=stale_work')).toBe('stale_work');
    expect(parseAttentionKind('?tab=command&kind=stale_work')).toBe('stale_work');
    expect(parseAttentionKind('?tab=command&view=operations&kind=stale_work')).toBeNull();
    expect(parseAttentionKind('?tab=monitor&kind=stale_work')).toBeNull();
    expect(parseAttentionKind('?tab=command&view=attention')).toBeNull();
  });
});

describe('EXTERNAL_LINKS', () => {
  it('are https links that never become a restorable ?tab= section', () => {
    for (const link of EXTERNAL_LINKS) {
      expect(new URL(link.href).protocol).toBe('https:');
      expect(parseUrlState(`?tab=${link.id}`).tab).toBeNull();
    }
  });
});

describe('Knowledge views in the URL', () => {
  it('restores decisions and audits, falls back to findings for anything else', () => {
    expect(parseUrlState('?tab=knowledge&view=decisions')).toEqual({ tab: 'knowledge', run: null, panel: 'decisions' });
    expect(parseUrlState('?tab=knowledge&view=audits')).toEqual({ tab: 'knowledge', run: null, panel: 'audits' });
    expect(parseUrlState('?tab=knowledge&view=readiness').panel).toBeNull();
    expect(parseUrlState('?tab=analytics&view=decisions').panel).toBeNull();
  });
});
