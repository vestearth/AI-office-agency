import { describe, expect, it } from 'vitest';
import { OPERATOR_NAMES, agentGlyph, runActor } from './agentDisplay';

describe('operators', () => {
  it('shows every operator a history row can record, not as unknown', () => {
    // 2026-10-21: history[].operator is one of claude codex cursor antigravity copilot.
    for (const op of ['claude', 'codex', 'cursor', 'antigravity', 'copilot']) {
      expect(OPERATOR_NAMES).toContain(op);
      expect(agentGlyph(op)).not.toBe(agentGlyph('unknown'));
    }
  });
});

describe('runActor', () => {
  it('shows how a finished run ended instead of an unknown agent', () => {
    // 2026-10-16: aborted TASK-EAR-404 read "❔ unknown" in Monitor and the live logs.
    expect(agentGlyph(runActor('aborted', undefined))).toBe('⏹️');
    expect(agentGlyph(runActor('done', 'unknown'))).toBe('✅');
    expect(runActor('in_review', 'reviewer')).toBe('reviewer');
  });
});
