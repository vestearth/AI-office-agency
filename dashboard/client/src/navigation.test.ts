import { describe, expect, it } from 'vitest';
import { defaultPanel, parseUrlState } from './navigation';

describe('parseUrlState', () => {
  it('restores every current top-level section, including intake', () => {
    expect(parseUrlState('?tab=intake')).toEqual({ tab: 'intake', run: null, panel: null });
    expect(parseUrlState('?tab=knowledge')).toEqual({ tab: 'knowledge', run: null, panel: null });
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
