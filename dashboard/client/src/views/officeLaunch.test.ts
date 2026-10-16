import { describe, expect, it } from 'vitest';
import type { OfficeLaunch, TaskLaunchContract } from '../../../shared/types';
import { contractLines, isActive, launchOutput, launchSummary, recentStatusWarning } from './officeLaunch';

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
});

describe('contractLines', () => {
  const contract = (over: Partial<TaskLaunchContract> = {}): TaskLaunchContract => ({
    outputFile: 'dev-output.yaml', outputWritten: true, statusSynced: true, validation: { ok: true, output: '' }, met: true, ...over,
  });
  it('lists failures first', () => {
    const lines = contractLines(contract({ statusSynced: false, met: false }));
    expect(lines[0]).toEqual({ ok: false, text: 'status.yaml not synced (sync-status-from-output.rb did not run)' });
    expect(lines.filter((l) => l.ok)).toHaveLength(2);
  });
  it('names the role output file', () => {
    expect(contractLines(contract({ outputWritten: false, met: false }))[0].text).toBe('dev-output.yaml not written during the run');
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
