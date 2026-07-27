import { describe, expect, it } from 'vitest';
import { parseUrlState } from './navigation';

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
