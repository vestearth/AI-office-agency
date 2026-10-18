import { describe, expect, it } from 'vitest';
import type { NewTaskOptions, NewTaskView } from '../../../shared/types';
import {
  emptyForm, formBlockers, gatesText, idPattern, newTaskLine, pmPolling, prefixLabel, reposLine, requestBody, reviewHeadline, submitLine, togglePreset, type NewTaskForm,
} from './newTask';

const options = (over: Partial<NewTaskOptions> = {}): NewTaskOptions => ({
  prefixes: { allowed: ['EAR', 'KAS', 'VS'], default: 'EAR' },
  presets: [{ name: 'staging', gates: ['implementation_verification', 'deploy_staging', 'staging_acceptance'] }, { name: 'production', gates: [] }, { name: 'backfill', gates: ['production_backfill'] }],
  writer: { cli: 'claude', usable: true }, tasks: [], ...over,
});
const form = (over: Partial<NewTaskForm> = {}): NewTaskForm => ({ ...emptyForm(options()), title: 'Add a thing', request: 'Please add it.', presets: ['staging'], ...over });
const view = (over: Partial<NewTaskView> = {}): NewTaskView => ({
  taskId: 'TASK-EAR-5', title: 'Add a thing', request: 'Please add it.', prefix: 'EAR', gates: { presets: ['staging'] }, createdAt: '2026-10-17T10:00:00Z',
  cli: 'claude', itemId: 'q1', itemIds: ['q1'], attempts: [{ taskId: 'TASK-EAR-5', exitCode: 0, message: 'Opened' }],
  state: 'pm', pm: { status: 'running', text: 'running', launchId: 'L1' }, ...over,
});

describe('the New task form', () => {
  it('starts on the dashboard prefix with no gate decision made', () => {
    expect(emptyForm(options())).toEqual({ title: '', request: '', prefix: 'EAR', gateChoice: 'presets', presets: [], noGatesReason: '' });
    expect(emptyForm(options({ prefixes: { allowed: ['EAR'], default: null } })).prefix).toBe('');
  });

  it('needs a title, a request, an offered prefix and a gate decision; presets or a no-gates reason', () => {
    expect(formBlockers(form(), options())).toEqual([]);
    expect(formBlockers(form({ title: ' ', request: '' }), options())).toEqual(['Give the task a title.', 'Describe the request: the pm step writes task.md from it.']);
    expect(formBlockers(form({ prefix: 'GW' }), options())).toEqual(['Pick a prefix.']);
    expect(formBlockers(form({ presets: [] }), options())).toEqual(['Pick at least one gate preset, or choose no delivery gates with the reason.']);
    expect(formBlockers(form({ gateChoice: 'none', noGatesReason: '  ' }), options())).toEqual(['Say why the task needs no delivery gates.']);
    expect(formBlockers(form({ gateChoice: 'none', noGatesReason: 'docs only' }), options())).toEqual([]);
    expect(formBlockers(form(), options({ writer: { cli: 'claude', usable: false, reason: 'not logged in' } }))).toEqual(['claude cannot run the pm step: not logged in.']);
    expect(formBlockers(form(), null)).toHaveLength(1);
  });

  it('sends presets or the no-gates reason, never both', () => {
    expect(requestBody(form({ title: ' T ', request: ' R ', presets: ['staging', 'backfill'], noGatesReason: 'left over' })))
      .toEqual({ title: 'T', request: 'R', prefix: 'EAR', presets: ['staging', 'backfill'] });
    expect(requestBody(form({ gateChoice: 'none', noGatesReason: ' docs only ' }))).toEqual({ title: 'Add a thing', request: 'Please add it.', prefix: 'EAR', noGatesReason: 'docs only' });
  });

  it('toggles presets in the presets file order', () => {
    const order = ['staging', 'production', 'backfill'];
    expect(togglePreset(['backfill'], 'staging', order)).toEqual(['staging', 'backfill']);
    expect(togglePreset(['staging', 'backfill'], 'staging', order)).toEqual(['backfill']);
  });

  it('words the id pattern, the prefix options and what Open does', () => {
    expect(idPattern('EAR')).toBe('TASK-EAR-NNN');
    expect(idPattern('')).toBe('TASK-NNN');
    expect(prefixLabel('', undefined)).toBe('(no prefix) · TASK-NNN');
    expect(submitLine(form({ presets: ['staging', 'backfill'] }), 'claude')).toBe('Opens the next TASK-EAR-NNN id with scripts/open-task.rb (gates staging + backfill), then runs a pm step on claude that writes task.md. It stops there for you to read and confirm.');
    expect(submitLine(form({ gateChoice: 'none' }), 'codex')).toMatch(/\(no delivery gates\), then runs a pm step on codex/);
  });
});

describe('the stop for the operator', () => {
  it('words each state in the list and the review', () => {
    expect(newTaskLine(view())).toBe('TASK-EAR-5 · Add a thing · pm running on claude');
    expect(newTaskLine(view({ pm: { status: 'queued', text: 'waiting for a free slot (2 of 2 running)' } }))).toBe('TASK-EAR-5 · Add a thing · pm waiting for a free slot (2 of 2 running) on claude');
    expect(newTaskLine(view({ state: 'pm-failed', pm: { status: 'failed', text: 'verification failed at validate: x' } }))).toBe('TASK-EAR-5 · Add a thing · pm step failed: verification failed at validate: x');
    expect(newTaskLine(view({ state: 'pm-failed', pm: { status: 'not started', text: 'could not start (failed: lease held)' } }))).toMatch(/pm step did not run: could not start/);
    expect(newTaskLine(view({ state: 'review', pm: { status: 'verified', text: 'verified · nothing to commit' } }))).toBe('TASK-EAR-5 · Add a thing · task.md ready for your review');
    expect(reviewHeadline(view({ state: 'pm-failed', pm: { status: 'failed', text: 'the step failed: exit 1' } }))).toMatch(/TASK-EAR-5 stays opened: Redo pm, or abort the task with the office tools\.$/);
    expect(reviewHeadline(view({ state: 'review', pm: { status: 'verified', text: 'verified · nothing to commit' } }))).toMatch(/^The pm step is verified \(verified · nothing to commit\)\. Read task\.md, then confirm/);
  });

  it('polls only while the pm step has not ended', () => {
    expect(pmPolling(view())).toBe(true);
    expect(pmPolling(view({ state: 'review' }))).toBe(false);
    expect(pmPolling(view({ state: 'pm-failed' }))).toBe(false);
    expect(pmPolling(null)).toBe(false);
  });

  it('shows the gate decision and the repositories proposed from the new task.md', () => {
    expect(gatesText(view())).toBe('Gate presets: staging');
    expect(gatesText(view({ gates: { none: 'docs only' } }))).toBe('No delivery gates: docs only');
    expect(reposLine(view({ proposed: ['api-gateway', 'shared-lib'], referenceOnly: ['Games-Lab-Android'] })))
      .toBe('Repositories proposed from task.md: api-gateway, shared-lib; reference only: Games-Lab-Android. You confirm them in the Start dialog.');
    expect(reposLine(view({ proposed: [] }))).toMatch(/^task\.md names no repository a Run would preselect: pick them/);
  });
});
