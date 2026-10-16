import { describe, expect, it } from 'vitest';
import type { OfficeLaunch, TaskStepResult } from '../../../shared/types';
import { isActive, launchOutput, launchStarted, launchSummary, recentStatusWarning, stepResultSections, stepVerdict, warningLaunch } from './officeLaunch';

const launch = (over: Partial<OfficeLaunch> = {}): OfficeLaunch => ({
  id: 'x', kind: 'task', key: 'TASK-EAR-1', label: 'TASK-EAR-1 dev', command: 'codex <dev prompt for TASK-EAR-1>',
  cwd: '/office', startedAt: '2026-10-16T09:00:00Z', status: 'running', log: '', truncated: false, ...over,
});
const now = Date.parse('2026-10-16T09:04:10Z');

describe('launchSummary', () => {
  it('shows elapsed minutes while running', () => {
    expect(launchSummary(launch(), now)).toBe('running · 4 min');
    expect(isActive(launch({ status: 'stopping' }))).toBe(true);
  });
  it('shows exit code and duration once finished', () => {
    expect(launchSummary(launch({ status: 'failed', exitCode: 9, finishedAt: '2026-10-16T09:12:00Z' }), now)).toBe('failed · exit 9 · 12 min');
    expect(isActive(launch({ status: 'succeeded', exitCode: 0 }))).toBe(false);
  });
  it('shows the time limit while running when the step has one', () => {
    expect(launchSummary(launch({ timeLimitMinutes: 30 }), now)).toBe('running · 4 of 30 min');
  });
  it('explains a lost launch instead of calling it running', () => {
    expect(launchSummary(launch({ status: 'lost' }), now)).toMatch(/^lost · .*without an exit code/);
    expect(isActive(launch({ status: 'lost' }))).toBe(false);
  });
});

describe('launchStarted', () => {
  it('says when a launch started and how long ago, so an old result does not read as current', () => {
    // 2026-10-17: Knowledge showed "Knowledge re-check: lost" from a round killed 17 hours earlier, with no time.
    expect(launchStarted(launch({ status: 'lost', startedAt: '2026-10-16T09:01:15Z' }), Date.parse('2026-10-17T02:10:00Z'))).toBe('started Oct 16, 09:01 · 17h ago');
    expect(launchStarted(launch({ startedAt: '2026-10-14T08:00:00Z' }), Date.parse('2026-10-16T09:00:00Z'))).toBe('started Oct 14, 08:00 · 2d ago');
    expect(launchStarted(launch(), now)).toBe('started Oct 16, 09:00 · 4 min ago');
  });
});

describe('recentStatusWarning', () => {
  it('warns about a recent status change when nothing runs from the dashboard', () => {
    expect(recentStatusWarning('2026-10-16T09:00:00Z', null, now)).toMatch(/changed 4 min ago.*another session/);
  });
  it('stays quiet for an old change, a running launch, or a change made by our own finished launch', () => {
    expect(recentStatusWarning('2026-10-16T08:00:00Z', null, now)).toBeNull();
    expect(recentStatusWarning('2026-10-16T09:00:00Z', launch(), now)).toBeNull();
    expect(recentStatusWarning('2026-10-16T09:02:00Z', launch({ status: 'succeeded', exitCode: 0, finishedAt: '2026-10-16T09:03:00Z' }), now)).toBeNull();
    expect(recentStatusWarning('2026-10-16T09:04:00Z', launch({ status: 'succeeded', exitCode: 0, finishedAt: '2026-10-16T09:03:00Z' }), now)).not.toBeNull();
  });
  it("does not take the dashboard's own sync after the step (verification ends after the launch) for another session", () => {
    const ended = launch({ status: 'succeeded', exitCode: 0, finishedAt: '2026-10-16T09:03:00Z' });
    const verifiedAt = { finishedAt: '2026-10-16T09:03:20Z' } as Pick<TaskStepResult, 'finishedAt'>;
    expect(recentStatusWarning('2026-10-16T09:03:10Z', warningLaunch(ended, verifiedAt), now)).toBeNull();
    expect(recentStatusWarning('2026-10-16T09:04:00Z', warningLaunch(ended, verifiedAt), now)).not.toBeNull();
    expect(warningLaunch(null, verifiedAt)).toBeNull();
  });
});

// Slice 3 (spec D6) replaced the mtime contract check (outputWritten / statusSynced by file
// time, which counted other sessions' edits) with the dashboard's own verification by the
// office scripts, so the contractLines tests became the step-result tests below.
describe('stepResultSections', () => {
  const result = (over: Partial<TaskStepResult> = {}): TaskStepResult => ({
    state: 'done', launchId: 'L1', runId: 'run-1', role: 'dev', cli: 'claude', model: 'claude-opus-5-5',
    protocol: { ok: true, text: "exit 0 with the CLI's final result event" },
    lease: { ok: true, text: 'held for the whole step, then ownership released: TASK-EAR-1 epoch=3' },
    checks: [
      { name: 'output', command: 'runs/TASK-EAR-1/dev-output.yaml written during the step', status: 'passed', detail: 'written' },
      { name: 'integrity', command: 'ruby scripts/task-input-integrity.rb verify', status: 'passed', detail: 'ok' },
      { name: 'validate', command: 'ruby validate-yaml.rb TASK-EAR-1', status: 'passed', detail: 'Validation passed: TASK-EAR-1' },
      { name: 'enforce', command: 'ruby scripts/enforce-output-contract.rb TASK-EAR-1 dev', status: 'passed', detail: 'output contract met' },
      { name: 'sync', command: 'ruby scripts/sync-status-from-output.rb TASK-EAR-1 dev', status: 'passed', detail: 'Status synced: assigned -> in_review (next: reviewer)' },
    ],
    verified: true, agentCommits: { ok: true, text: 'no agent commit', found: [] },
    commits: [{ repo: 'slip-api', path: '/w', branch: 'task/TASK-EAR-1', status: 'committed', sha: 'abcdef1234567', text: 'committed abcdef1234 on task/TASK-EAR-1 (2 files)' }],
    runsChanged: [{ path: 'status.yaml', change: 'modified' }], ...over,
  });
  it('orders the end state: protocol, each office script, agent-commit detection, the dashboard commit', () => {
    expect(stepResultSections(result()).map((s) => s.title)).toEqual(['Protocol', 'Office scripts', 'Agent commits', 'Dashboard commit', 'Task lease', 'Changed in runs/ (not committed)']);
    const scripts = stepResultSections(result())[1].lines;
    expect(scripts.map((l) => l.text)).toEqual([
      'output: written', 'integrity: ok', 'validate: Validation passed: TASK-EAR-1', 'enforce: output contract met', 'sync: Status synced: assigned -> in_review (next: reviewer)',
    ]);
    expect(stepResultSections(result())[3].lines[0]).toEqual({ ok: true, text: 'slip-api: committed abcdef1234 on task/TASK-EAR-1 (2 files)' });
  });
  it('shows a failing script with its output and the skipped ones as skipped, not passed', () => {
    const failed = result({ verified: false, checks: [
      { name: 'output', command: 'o', status: 'passed', detail: 'written' },
      { name: 'validate', command: 'ruby validate-yaml.rb T', status: 'failed', detail: 'Validation failed: T', exitCode: 1, output: ' - next_action.agent is not a role' },
      { name: 'enforce', command: 'e', status: 'skipped', detail: 'not run: validate-yaml.rb failed' },
    ], commits: [{ repo: 'slip-api', path: '/w', branch: 'b', status: 'skipped', text: 'no commit: verification failed at validate; the diff stays uncommitted in the worktree' }] });
    const lines = stepResultSections(failed)[1].lines;
    expect(lines[1]).toEqual({ ok: false, text: 'validate: Validation failed: T (exit 1)', output: ' - next_action.agent is not a role' });
    expect(lines[2]).toEqual({ ok: null, text: 'enforce: not run: validate-yaml.rb failed' });
    expect(stepVerdict(failed)).toBe('Not verified: validate failed · no commit');
  });
  it('names the verdict: verified and committed, nothing to commit, an agent commit, verifying', () => {
    expect(stepVerdict(result())).toBe('Verified · committed abcdef1234');
    expect(stepVerdict(result({ commits: [{ repo: 'r', path: '/w', branch: 'b', status: 'empty', text: 'no changes in r: nothing to commit' }] }))).toBe('Verified · nothing to commit');
    expect(stepVerdict(result({ agentCommits: { ok: false, text: '1 commit the dashboard did not make', found: [{ repo: 'r', text: 'abc agent did this' }] } }))).toBe('Failed: an agent committed · no dashboard commit');
    expect(stepVerdict(result({ state: 'verifying' }))).toBe('Verifying with the office scripts…');
    expect(stepVerdict(result({ protocol: { ok: false, text: 'stopped by the operator' }, verified: false }))).toBe('Step stopped by the operator · not verified, no commit');
  });
});

describe('launchOutput', () => {
  it('shows readable progress for an adapter launch, not its raw JSON', () => {
    const out = launchOutput(launch({ cli: 'claude', progress: ['Session started', '→ Bash: ls'], log: '{"type":"system"}' }));
    expect(out).toEqual({ label: 'Progress', text: 'Session started\n→ Bash: ls' });
  });
  it('says when there is no progress yet, or none came', () => {
    expect(launchOutput(launch({ progress: [] })).text).toBe('Waiting for output…');
    expect(launchOutput(launch({ progress: [], status: 'failed', exitCode: 1 })).text).toBe('The CLI reported no progress.');
  });
  it('keeps the raw log for a launch without progress (recorded before the adapter)', () => {
    expect(launchOutput(launch({ log: 'plain', truncated: true }))).toEqual({ label: 'Output (last 64 KB)', text: 'plain' });
    expect(launchOutput(launch()).text).toBe('Waiting for output…');
  });
});
