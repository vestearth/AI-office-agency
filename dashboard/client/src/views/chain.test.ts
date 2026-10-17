import { describe, expect, it } from 'vitest';
import type { ChainStepView, TaskChainView } from '../../../shared/types';
import {
  chainButtonLabel, chainConfirmLine, chainHeadline, chainPolling, chainStepLine, chainTone, pairingError, pairingLineShort, plannedPairing, runningChainLine, showChain, stepCli,
} from './chain';

const step = (over: Partial<ChainStepView> = {}): ChainStepView => ({ n: 1, role: 'dev', cli: 'claude', model: 'claude-opus-5-5', itemId: 'q-1', status: 'running', commits: [], ...over });
const chain = (over: Partial<TaskChainView> = {}): TaskChainView => ({
  id: 'chain-1', taskId: 'TASK-EAR-1', startedAt: '2026-10-17T10:00:00Z', pairing: { writer: 'claude', reviewer: 'codex' }, cap: 6, repos: [{ repo: 'demo' }],
  steps: [step()], active: true, ...over,
});

describe('pairing before start', () => {
  it('the reviewer runs on the reviewer CLI, every other role on the writer', () => {
    const p = { writer: 'claude' as const, reviewer: 'codex' as const };
    expect(stepCli('dev', p)).toBe('claude');
    expect(stepCli('debugger', p)).toBe('claude');
    expect(stepCli('reviewer', p)).toBe('codex');
    expect(stepCli('reviewer', { writer: 'codex', reviewer: 'claude' })).toBe('claude');
  });
  it('refuses the same CLI on both sides', () => {
    expect(pairingError({ writer: 'codex', reviewer: 'codex' })).toBe('The reviewer must be a different CLI from the writer.');
    expect(pairingError({ writer: 'codex', reviewer: 'claude' })).toBeNull();
  });
  it('says the plan, the button and the confirm line', () => {
    expect(plannedPairing('dev', { writer: 'claude', reviewer: 'codex' }, 6)).toBe(
      'Step 1: dev on claude. After each verified step, decide-next-step.rb picks the next role: reviewer runs on codex, pm, dev, dev-2, debugger and devops on claude; free-roam never runs. At most 6 steps.',
    );
    expect(plannedPairing('reviewer', { writer: 'codex', reviewer: 'claude' }, 1)).toMatch(/^Step 1: reviewer on claude\..*At most 1 step\.$/);
    expect(chainButtonLabel({ writer: 'claude', reviewer: 'codex' }, false)).toBe('Run chain (claude writes, codex reviews)');
    expect(chainButtonLabel({ writer: 'claude', reviewer: 'codex' }, true)).toBe('Starting…');
    expect(pairingLineShort({ writer: 'codex', reviewer: 'claude' })).toBe('codex writes · claude reviews');
    expect(chainConfirmLine({ role: 'dev', taskId: 'TASK-EAR-1', pairing: { writer: 'claude', reviewer: 'codex' }, cap: 6, repos: ['demo'] }))
      .toBe('Run TASK-EAR-1 from dev until a human is needed (at most 6 steps), claude writing and codex reviewing, in demo');
  });
});

describe('the timeline', () => {
  it('words each step with role, CLI, model, status, verification, verdict and decision', () => {
    expect(chainStepLine(step())).toBe('1. dev · claude (claude-opus-5-5) · running');
    expect(chainStepLine(step({ status: 'queued', waitingFor: 'a free slot (2 of 2 running)' }))).toBe('1. dev · claude (claude-opus-5-5) · queued, waiting for a free slot (2 of 2 running)');
    expect(chainStepLine(step({ status: 'verified', verification: 'verified · committed demo 1a2b3c4d5e', decision: { next: 'reviewer', terminal: false } })))
      .toBe('1. dev · claude (claude-opus-5-5) · verified · committed demo 1a2b3c4d5e → reviewer');
    expect(chainStepLine(step({ n: 2, role: 'reviewer', cli: 'codex', model: 'gpt-5.6-sol', status: 'verified', verification: 'verified · nothing to commit', verdict: 'approved', decision: { next: 'done', terminal: true } })))
      .toBe('2. reviewer · codex (gpt-5.6-sol) · verified · nothing to commit · approved → done');
    expect(chainStepLine(step({ status: 'not started', waitingFor: 'failed: TASK ownership refused' }))).toBe('1. dev · claude (claude-opus-5-5) · not started: failed: TASK ownership refused');
    expect(chainStepLine(step({ status: 'verifying' }))).toBe('1. dev · claude (claude-opus-5-5) · verifying with the office scripts');
  });
  it('heads a running chain with its step, an ended one with why it stopped', () => {
    expect(chainHeadline(chain())).toBe('Chain step 1 of 6: dev on claude · running');
    const ended = chain({ active: false, ended: { at: '2026-10-17T11:00:00Z', kind: 'changes', reason: 'x' }, steps: [step(), step({ n: 2 })] });
    expect(chainHeadline(ended)).toBe('Chain stopped after 2 steps: Changes requested more than twice');
    expect(chainTone(chain())).toBe('launch-running');
    expect(chainTone(ended)).toBe('launch-stopped');
    expect(chainTone(chain({ active: false, ended: { at: 'x', kind: 'done', reason: 'r' } }))).toBe('launch-succeeded');
    expect(chainTone(chain({ active: false, ended: { at: 'x', kind: 'verification', reason: 'r' } }))).toBe('launch-failed');
    expect(runningChainLine(chain())).toBe('TASK-EAR-1 chain · step 1 of 6 · dev on claude · running');
  });
  it('shows a running chain, and an ended one until a later Run starts; polls while it runs', () => {
    const ended = chain({ active: false, ended: { at: '2026-10-17T11:00:00Z', kind: 'done', reason: 'r' } });
    expect(showChain(undefined, null)).toBe(false);
    expect(showChain(chain(), { startedAt: '2026-10-18T00:00:00Z' })).toBe(true);
    expect(showChain(ended, { startedAt: '2026-10-17T10:30:00Z' })).toBe(true);
    expect(showChain(ended, { startedAt: '2026-10-17T12:00:00Z' })).toBe(false);
    expect(chainPolling(chain())).toBe(true);
    expect(chainPolling(ended)).toBe(false);
  });
});
