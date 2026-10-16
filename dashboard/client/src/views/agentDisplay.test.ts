import { describe, expect, it } from 'vitest';
import { agentGlyph, runActor } from './agentDisplay';

describe('runActor', () => {
  it('shows how a finished run ended instead of an unknown agent', () => {
    // 2026-10-16: aborted TASK-EAR-404 read "❔ unknown" in Monitor and the live logs.
    expect(agentGlyph(runActor('aborted', undefined))).toBe('⏹️');
    expect(agentGlyph(runActor('done', 'unknown'))).toBe('✅');
    expect(runActor('in_review', 'reviewer')).toBe('reviewer');
  });
});
