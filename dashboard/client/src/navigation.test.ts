import { describe, expect, it } from 'vitest';
import { defaultPanel, parseUrlState } from './navigation';
import { DASHBOARD_SECTIONS } from './views/types';

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
