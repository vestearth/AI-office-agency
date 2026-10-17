import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { ChainStopKind } from '../../../shared/types';
import { ruby, tail } from './officeScripts';

// What a role chain (taskChain.ts, D12) asks the office between steps. The decisions stay
// in the office's own scripts, run by argv from the office root like every adapter
// script (officeScripts.ts): the next role is scripts/decide-next-step.rb (the auto
// pipeline's decision half: next_action, the reviewer verdict fallback, the fixed phase
// map and the completion gates), the authorization a role needs is
// scripts/authorization-dispatch-check.rb. The dashboard only reads status.yaml and the
// reviewer's output here; it never writes them.

export interface NextStep {
  next: string;
  terminal: boolean;
  /** What the script warned on stderr (a completion gate blocking done). */
  note?: string;
  /** The script did not answer (exit code, unparsable line): the chain stops on it. */
  error?: string;
}

/** `next=<agent-or-empty> terminal=<true|false>`, the script's one line; null when it is not that. */
export function parseDecision(stdout: string): { next: string; terminal: boolean } | null {
  const m = /^next=(\S*) terminal=(true|false)$/m.exec(stdout.trim());
  return m ? { next: m[1], terminal: m[2] === 'true' } : null;
}

/** ruby scripts/decide-next-step.rb <role> runs/<T>/<role>-output.yaml runs/<T>/status.yaml */
export async function decideNextStep(officeRoot: string, taskId: string, role: string): Promise<NextStep> {
  const dir = path.join(officeRoot, 'runs', taskId);
  const r = await ruby(officeRoot, 'scripts/decide-next-step.rb', [role, path.join(dir, `${role}-output.yaml`), path.join(dir, 'status.yaml')]);
  const parsed = parseDecision(r.stdout);
  if (r.code !== 0 || !parsed) return { next: '', terminal: false, error: `decide-next-step.rb gave no decision (exit ${r.code}): ${tail(r.stderr || r.stdout, 3) || 'no output'}` };
  const note = tail(r.stderr, 3);
  return { ...parsed, ...(note ? { note } : {}) };
}

/**
 * ruby scripts/authorization-dispatch-check.rb decide <T> --role <role>. The chain is
 * stricter than run-agent.sh: a missing grant or a config error stops it whatever the
 * mode (warn_only would let run-agent.sh go on with a warning), and a task the script
 * cannot judge stops it too.
 */
export async function authorizationCheck(officeRoot: string, taskId: string, role: string): Promise<{ ok: boolean; text: string }> {
  const r = await ruby(officeRoot, 'scripts/authorization-dispatch-check.rb', ['decide', taskId, '--role', role]);
  const m = /outcome=(\S+) mode=(\S+) actions=(\S*)/.exec(r.stdout);
  if (!m || ![0, 14].includes(r.code)) return { ok: false, text: `the authorization check could not judge ${taskId} (authorization-dispatch-check.rb exit ${r.code}: ${tail(r.stderr || r.stdout, 2) || 'no output'})` };
  const [, outcome, mode, actions] = m;
  if (outcome === 'not_applicable') return { ok: true, text: 'no authorization needed' };
  if (outcome === 'authorized') return { ok: true, text: `authorized for ${actions}` };
  if (outcome === 'missing_authorization') return { ok: false, text: `the ${role} step needs an authorization grant for ${actions || 'a pending gate'} (authorization_dispatch mode ${mode}); a person records it with scripts/record-authorization.rb` };
  return { ok: false, text: `the authorization check reported ${outcome} (mode ${mode}): fix authorization_dispatch in office.config.yaml` };
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' && x ? Object.values(x as Record<string, unknown>).join(':') : String(x))).filter(Boolean) : []);

/**
 * Why the task cannot take another unattended step now, from status.yaml; null when it
 * can. Blocked (phase blocked, blocked_on, waiting_for, waits_on), finished (done,
 * aborted), escalated, or validation_failed.
 */
export function taskHold(runsDir: string, taskId: string): { kind: ChainStopKind; reason: string } | null {
  let status: Record<string, unknown>;
  try {
    status = (yaml.load(fs.readFileSync(path.join(runsDir, taskId, 'status.yaml'), 'utf8')) as Record<string, unknown> | null) ?? {};
  } catch (err) {
    return { kind: 'blocked', reason: `runs/${taskId}/status.yaml cannot be read (${(err as Error).message.split('\n')[0]})` };
  }
  const phase = String(status.phase ?? status.state ?? '');
  const blockedOn = list(status.blocked_on);
  const waitingFor = list(status.waiting_for);
  const waitsOn = list(status.waits_on);
  if (phase === 'done' || phase === 'aborted') return { kind: 'done', reason: `the task is ${phase}` };
  if (phase === 'escalated') return { kind: 'escalated', reason: 'the task is escalated (free-roam): a person decides what happens next' };
  if (phase === 'validation_failed') return { kind: 'verification', reason: 'the task is in validation_failed: the last output did not meet its contract' };
  const why = [
    ...(blockedOn.length ? [`blocked on ${blockedOn.join(', ')}`] : []),
    ...(waitingFor.length ? [`waiting for ${waitingFor.join('; ')}`] : []),
    ...(waitsOn.length ? [`waits on ${waitsOn.join(', ')}`] : []),
  ];
  if (phase === 'blocked' || why.length) return { kind: 'blocked', reason: `the task is ${phase === 'blocked' ? 'blocked' : 'held'}${why.length ? `: ${why.join('; ')}` : ''}` };
  return null;
}

/** review_verdict from runs/<T>/reviewer-output.yaml, if any. */
export function reviewVerdict(runsDir: string, taskId: string): string | undefined {
  try {
    const out = yaml.load(fs.readFileSync(path.join(runsDir, taskId, 'reviewer-output.yaml'), 'utf8')) as { review_verdict?: unknown } | null;
    return typeof out?.review_verdict === 'string' ? out.review_verdict.trim() || undefined : undefined;
  } catch { return undefined; }
}
