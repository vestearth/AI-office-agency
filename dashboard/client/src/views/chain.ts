import type { ChainPairing, ChainStepView, ChainStopKind, TaskChainView } from '../../../shared/types';

// Run until a human is needed (docs/start-task-redesign-spec.md, D12): the chain's
// planned writer/reviewer pairing before it starts, and its timeline (D7) while it runs
// and after it stopped. The server decides every next role (scripts/decide-next-step.rb)
// and every stop; these only word what it reports.

export const STOP_LABELS: Record<ChainStopKind, string> = {
  operator: 'Stopped by you',
  failed: 'A step failed',
  verification: 'Verification failed',
  gate: 'A completion gate needs you',
  authorization: 'An authorization is needed',
  blocked: 'The task is blocked',
  changes: 'Changes requested more than twice',
  cap: 'Step cap reached',
  done: 'Done: yours to close',
  escalated: 'Escalated: a person decides',
  cli: 'A CLI cannot run',
  pairing: 'Reviewer would be the writer',
  'no-next': 'No next role',
  queue: 'Next step could not be queued',
};

/** The CLI a role runs on in a chain: the reviewer on the reviewer CLI, every other role on the writer CLI. */
export const stepCli = (role: string, pairing: ChainPairing) => (role === 'reviewer' ? pairing.reviewer : pairing.writer);

/** Why the pairing cannot start a chain; null when it can. */
export const pairingError = (p: ChainPairing): string | null => (p.writer === p.reviewer ? 'The reviewer must be a different CLI from the writer.' : null);

/** The plan shown before start: who runs what, and where it stops. */
export function plannedPairing(role: string, pairing: ChainPairing, cap: number): string {
  return `Step 1: ${role} on ${stepCli(role, pairing)}. After each verified step, decide-next-step.rb picks the next role: reviewer runs on ${pairing.reviewer}, pm, dev, dev-2, debugger and devops on ${pairing.writer}; free-roam never runs. At most ${cap} step${cap === 1 ? '' : 's'}.`;
}

/** "claude writes · codex reviews". */
export const pairingLineShort = (p: ChainPairing) => `${p.writer} writes · ${p.reviewer} reviews`;

/** The start button's text. */
export const chainButtonLabel = (pairing: ChainPairing, busy: boolean) => (busy ? 'Starting…' : `Run chain (${pairing.writer} writes, ${pairing.reviewer} reviews)`);

/** What the confirm line promises. */
export function chainConfirmLine(input: { role: string; taskId: string; pairing: ChainPairing; cap: number; repos: string[] }): string {
  return `Run ${input.taskId} from ${input.role} until a human is needed (at most ${input.cap} steps), ${input.pairing.writer} writing and ${input.pairing.reviewer} reviewing${input.repos.length ? `, in ${input.repos.join(', ')}` : ''}`;
}

const STATUS_TEXT: Record<ChainStepView['status'], string> = {
  queued: 'queued', starting: 'starting', running: 'running', verifying: 'verifying with the office scripts', verified: 'verified', failed: 'failed', 'not started': 'not started',
};

/** One step of the timeline: "2. reviewer · codex (gpt-5.6-sol) · verified · committed demo 1a2b3c4d5e · approved → done". */
export function chainStepLine(step: ChainStepView): string {
  const head = `${step.n}. ${step.role} · ${step.cli}${step.model ? ` (${step.model})` : ''}`;
  const state = step.status === 'queued' ? `queued${step.waitingFor ? `, waiting for ${step.waitingFor}` : ''}`
    : step.status === 'not started' ? `not started${step.waitingFor ? `: ${step.waitingFor}` : ''}`
      : step.verification && ['verified', 'failed'].includes(step.status) ? step.verification : STATUS_TEXT[step.status];
  const verdict = step.verdict ? ` · ${step.verdict}` : '';
  const next = step.decision ? ` → ${step.decision.terminal ? 'done' : step.decision.next || 'no next role'}` : '';
  return `${head} · ${state}${verdict}${next}`;
}

/** The timeline's heading. */
export function chainHeadline(chain: TaskChainView): string {
  const last = chain.steps[chain.steps.length - 1];
  if (chain.active) return `Chain step ${chain.steps.length} of ${chain.cap}${last ? `: ${last.role} on ${last.cli} · ${STATUS_TEXT[last.status]}` : ''}`;
  const n = chain.steps.length;
  return `Chain stopped after ${n} step${n === 1 ? '' : 's'}: ${chain.ended ? STOP_LABELS[chain.ended.kind] : 'ended'}`;
}

/** Command › Operations › Running now: one line per running chain. */
export function runningChainLine(chain: TaskChainView): string {
  const last = chain.steps[chain.steps.length - 1];
  return `${chain.taskId} chain · step ${chain.steps.length} of ${chain.cap}${last ? ` · ${last.role} on ${last.cli} · ${STATUS_TEXT[last.status]}` : ''}`;
}

/** Whether the card shows the task's newest chain: while it runs, and after it stopped until a later Run starts. */
export function showChain(chain: TaskChainView | undefined, launch: { startedAt: string } | null | undefined): chain is TaskChainView {
  if (!chain) return false;
  if (chain.active || !chain.ended || !launch) return true;
  return launch.startedAt <= chain.ended.at;
}

/** Keep re-reading the task while its chain runs (between steps nothing else runs). */
export const chainPolling = (chain: TaskChainView | undefined) => Boolean(chain?.active);

/** The status class of the timeline's frame (reuses the launch status colours). */
export function chainTone(chain: TaskChainView): string {
  if (chain.active) return 'launch-running';
  if (!chain.ended) return 'launch-stopped';
  return chain.ended.kind === 'done' ? 'launch-succeeded' : ['failed', 'verification'].includes(chain.ended.kind) ? 'launch-failed' : 'launch-stopped';
}
