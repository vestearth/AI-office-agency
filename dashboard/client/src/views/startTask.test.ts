import { describe, expect, it } from 'vitest';
import type { OfficeLaunch, OpenHandoff, TaskLaunchResponse } from '../../../shared/types';
import { defaultRole, handoffLine, openBlockers, openDoneMessage, promptLengthLine, taskWarnings } from './startTask';

const now = Date.parse('2026-10-17T12:00:00Z');
const handoff = (over: Partial<OpenHandoff> = {}): OpenHandoff => ({
  id: 'h1', at: '2026-10-17T11:50:00Z', target: 'codex-app', role: 'dev', worktree: '/ws/.worktrees/api-gateway-TASK-EAR-1', repos: ['api-gateway'], promptSha256: 'x', ...over,
});
const launch = (over: Partial<OfficeLaunch> = {}): OfficeLaunch => ({
  id: 'L', kind: 'task', key: 'TASK-EAR-1', label: 'TASK-EAR-1 dev', command: 'claude -p', cwd: '/w', startedAt: '2026-10-17T10:00:00Z',
  status: 'succeeded', exitCode: 0, finishedAt: '2026-10-17T10:30:00Z', log: '', truncated: false, ...over,
});
const open = { available: true, promptCap: 5000 };

describe('defaultRole', () => {
  it('takes the recorded next action, then the current agent; done offers reviewer; unknown falls back to dev', () => {
    expect(defaultRole('debugger', 'dev')).toBe('debugger');
    expect(defaultRole(undefined, 'devops')).toBe('devops');
    expect(defaultRole('done')).toBe('reviewer');
    expect(defaultRole(undefined, 'claude')).toBe('dev');
  });
});

describe('taskWarnings', () => {
  it('warns a Run about an Open hand-off recorded after the last Run, and keeps the status.yaml warning', () => {
    const data: TaskLaunchResponse = { launch: launch(), statusChangedAt: '2026-10-17T11:55:00Z', lastHandoff: handoff() };
    const warnings = taskWarnings(data, now);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^status\.yaml changed 5 min ago/);
    expect(warnings[1]).toMatch(/^dev was opened in Codex app 10 min ago, after the last Run \(\/ws\/\.worktrees\/api-gateway-TASK-EAR-1\)/);
  });
  it('says nothing about a hand-off a later Run already followed, or while a step runs', () => {
    expect(taskWarnings({ launch: launch({ startedAt: '2026-10-17T11:55:00Z', finishedAt: '2026-10-17T11:58:00Z' }), lastHandoff: handoff() }, now)).toEqual([]);
    expect(taskWarnings({ launch: launch({ status: 'running', finishedAt: undefined }), lastHandoff: handoff() }, now)).toEqual([]);
  });
  it('warns with no Run at all', () => {
    expect(taskWarnings({ launch: null, lastHandoff: handoff({ target: 'cursor' }) }, now)[0]).toMatch(/opened in Cursor \(prompt only\) 10 min ago \(/);
  });
});

describe('openBlockers', () => {
  it('refuses a deep link off macOS and a prompt over the cap, with the count; cursor is never blocked', () => {
    expect(openBlockers('claude-desktop', { available: false, reason: 'Open is macOS only for now', promptCap: 5000 }, 'p')).toEqual(['Open is macOS only for now.']);
    expect(openBlockers('claude-cli', open, 'x'.repeat(5000))).toEqual([]);
    expect(openBlockers('claude-cli', open, 'x'.repeat(5001))[0]).toMatch(/5,001 characters, over the 5,000.*Copy prompt/);
    expect(openBlockers('cursor', { available: false, promptCap: 5000 }, 'x'.repeat(9000))).toEqual([]);
  });
  it('shows the prompt length against the cap', () => {
    expect(promptLengthLine('x'.repeat(3643), 5000)).toBe('3,643 of 5,000 characters');
  });
});

describe('open messages', () => {
  it('a deep link says it was sent, not delivered; cursor says to open the folder and paste', () => {
    expect(openDoneMessage({ handoff: handoff({ target: 'claude-cli' }), url: 'claude-cli://open?cwd=x&q=y' })).toMatch(/^Open request sent to Claude Code in the terminal for \/ws\/.*not sent\. Recorded on the task; the dashboard does not verify/);
    expect(openDoneMessage({ handoff: handoff({ target: 'cursor' }) })).toMatch(/^Worktree ready: \/ws\/\.worktrees\/api-gateway-TASK-EAR-1\. Open that folder in Cursor/);
    expect(handoffLine(handoff())).toMatch(/^Last opened: dev in Codex app · Oct 17, 11:50 · \/ws\//);
  });
});
