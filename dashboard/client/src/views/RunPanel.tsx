import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChainPairing, OfficeLaunch, OfficeLaunchTools, RunSummary, TaskLaunchCli, TaskLaunchResponse, WorktreeTarget } from '../../../shared/types';
import { apiFetchJson } from '../api';
import { chainButtonLabel, chainConfirmLine, pairingError, plannedPairing, showChain, stepCli } from './chain';
import { ChainTimeline } from './ChainTimeline';
import { isActive } from './officeLaunch';
import { OfficeLaunchStatus, StepResult, useOfficeLaunch } from './OfficeLaunchStatus';
import { QueuedRun, QueueFailed } from './RunQueuePanel';
import { afterTaskOptions, confirmLine, defaultAtInput, runButtonLabel, TRIGGER_LABELS, triggerFromForm, type TriggerKind } from './runQueue';
import { runBlockedReason } from './startTask';
import { startNotes } from './taskWorkspace';

// Start or open task › Run: one role step in an agent CLI, unattended, with the prompt
// the server builds from the task's files (previewed in the dialog). The agent writes
// only its role output; the server holds the task's ownership lease for the whole step,
// then runs validate-yaml.rb, enforce-output-contract.rb and sync-status-from-output.rb
// itself and, when they pass, commits each worktree's diff locally on the task branch
// (never pushed). The step runs in the task's worktrees, each CLI in its own sandbox
// (server cliAdapter.ts): writes only in the worktrees and the task's runs dir, network
// off, no permission prompts. Every Run goes through the dashboard's queue (D13): now
// (starts at once when a slot is free under the cap), at a time, or after another task's
// step or chain ends; a queued Run can be cancelled until it starts.
//
// "Until a human is needed" (D12) runs a role chain instead: the same step, then the
// role scripts/decide-next-step.rb names after each verified step, on the pairing's CLI
// (the writer for pm/dev/dev-2/debugger/devops, the reviewer, always a different CLI,
// for reviewer), until a stop rule needs a person.
const CLIS: TaskLaunchCli[] = ['claude', 'codex', 'cursor-agent'];

const CLI_HELP: Record<TaskLaunchCli, string> = {
  claude: 'claude -p · sandboxed commands, network off, no prompts; only your user settings load (no project hooks); push and web tools refused',
  codex: 'codex exec · model pinned by the dashboard (DASHBOARD_CODEX_MODEL) · workspace-write sandbox, network off, no /tmp, never asks for approval',
  'cursor-agent': 'cursor-agent -p · Cursor sandbox (.cursor/sandbox.json written by the dashboard in the worktree), network denied; --trust only on a worktree the dashboard created',
};

type Mode = 'step' | 'chain';

export function RunPanel({ taskId, role, note, tools, targets, primary, blockers, prompt, launchState, actionsTarget, initialMode }: {
  taskId: string; role: string; note: string;
  tools: OfficeLaunchTools | null;
  /** The confirmed repositories, null while loading. */
  targets: WorktreeTarget[] | null;
  /** The primary worktree's planned path. */
  primary?: string;
  /** Why the repositories cannot run yet. */
  blockers: string[];
  prompt: string;
  launchState: ReturnType<typeof useOfficeLaunch<TaskLaunchResponse>>;
  /** The dialog footer: Start sits there. */
  actionsTarget: HTMLElement | null;
  /** One step (default) or a chain: New task's Confirm opens on the chain. */
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode ?? 'step');
  const [cli, setCli] = useState<TaskLaunchCli>('claude');
  const [pairing, setPairing] = useState<ChainPairing | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [when, setWhen] = useState<TriggerKind>('now');
  const [atInput, setAtInput] = useState(() => defaultAtInput());
  const [afterTask, setAfterTask] = useState('');
  const [tasks, setTasks] = useState<{ id: string; label: string }[] | null>(null);
  const { data, launch, error, busy, active, submit, submitTo, stop, lastResponse, refresh } = launchState;
  const route = `/api/launch/task/${encodeURIComponent(taskId)}`;
  const repoKey = JSON.stringify(targets);
  const chainPairing: ChainPairing = pairing ?? { writer: tools?.chain?.writer ?? 'claude', reviewer: tools?.chain?.reviewer ?? 'codex' };
  const chainCap = cap ?? tools?.chain?.cap ?? 6;
  useEffect(() => setConfirmed(false), [mode, role, cli, note, repoKey, when, atInput, afterTask, chainPairing.writer, chainPairing.reviewer, chainCap]);
  const waitsOnTask = when === 'after' || when === 'after-chain';
  // The tasks a Run can wait on, read once "after" is picked.
  useEffect(() => {
    if (!waitsOnTask || tasks) return;
    Promise.all([
      apiFetchJson<RunSummary[]>('/api/runs'),
      apiFetchJson<{ launches: OfficeLaunch[] }>('/api/launch/active').catch(() => ({ launches: [] as OfficeLaunch[] })),
    ]).then(([runs, running]) => setTasks(afterTaskOptions(runs, taskId, new Set(running.launches.map((l) => l.key)))))
      .catch(() => setTasks([]));
  }, [waitsOnTask, tasks, taskId]);
  const trigger = triggerFromForm(when, atInput, afterTask);
  const queued = data?.queued;
  const chain = data?.chain;
  const chainRunning = Boolean(chain?.active);

  const usability = (id: TaskLaunchCli) => tools?.clis.find((c) => c.id === id);
  const stepCliNow = mode === 'chain' ? stepCli(role, chainPairing) : cli;
  const cliOk = usability(stepCliNow)?.available ?? false;
  const pairingProblem = mode === 'chain' ? (pairingError(chainPairing) ?? (role === 'free-roam' ? 'free-roam never runs in a chain: Run it as one step.' : null)) : null;
  const result = !isActive(launch) ? data?.result : undefined;
  const notes = startNotes(lastResponse as Parameters<typeof startNotes>[0]);

  const blockedReason = runBlockedReason({
    busy, loading: !prompt || !targets, cli: stepCliNow, cliOk, blockers, problem: pairingProblem ?? ('error' in trigger ? trigger.error : null),
    activeNow: active && when === 'now', queued: Boolean(queued), chainRunning, confirmed,
  });
  const disabled = busy || blockedReason !== null;
  const startButton = (
    <>
    {blockedReason && <span className="handoff-help launch-blocked" role="status">{blockedReason}</span>}
    <button type="button" className="form-button-primary" disabled={disabled}
      onClick={async () => {
        const body = { role, note, repos: targets, trigger };
        const ok = mode === 'chain'
          ? await submitTo(`${route}/chain`, { ...body, writer: chainPairing.writer, reviewer: chainPairing.reviewer, cap: chainCap })
          : await submit({ ...body, cli });
        if (ok) setConfirmed(false);
      }}>
      {mode === 'chain' ? chainButtonLabel(chainPairing, busy) : runButtonLabel(when, cli, busy)}
    </button>
    </>
  );

  return (
    <section className="cli-panel" aria-label="Run the step">
      <div className="start-actions" role="group" aria-label="How far">
        {([['step', 'One step'], ['chain', 'Until a human is needed']] as const).map(([id, label]) => (
          <button key={id} type="button" className={`section-tab sidebar-chip ${mode === id ? 'active' : ''}`} aria-pressed={mode === id}
            disabled={busy} onClick={() => setMode(id)}>{label}</button>
        ))}
      </div>
      {mode === 'step' ? (
        <>
          <label className="dialog-label" htmlFor="office-cli">CLI</label>
          <select id="office-cli" className="form-input" value={cli} disabled={active || busy} onChange={(e) => setCli(e.target.value as TaskLaunchCli)}>
            {CLIS.map((id) => (
              <option key={id} value={id} disabled={tools ? !usability(id)?.available : false}>
                {id}{tools && !usability(id)?.available ? ' (cannot run)' : ''}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <div className="chain-pairing">
            {(['writer', 'reviewer'] as const).map((side) => (
              <div key={side}>
                <label className="dialog-label" htmlFor={`chain-${side}`}>{side === 'writer' ? 'Writes (pm, dev, dev-2, debugger, devops)' : 'Reviews'}</label>
                <select id={`chain-${side}`} className="form-input" value={chainPairing[side]} disabled={busy || chainRunning}
                  onChange={(e) => setPairing({ ...chainPairing, [side]: e.target.value as TaskLaunchCli })}>
                  {CLIS.map((id) => <option key={id} value={id}>{id}{tools && !usability(id)?.available ? ' (cannot run)' : ''}</option>)}
                </select>
              </div>
            ))}
            <div>
              <label className="dialog-label" htmlFor="chain-cap">Step cap</label>
              <input id="chain-cap" type="number" min={1} max={20} className="form-input" value={chainCap} disabled={busy || chainRunning}
                onChange={(e) => setCap(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
            </div>
          </div>
          <p className="handoff-help">{plannedPairing(role, chainPairing, chainCap)}</p>
          <p className="handoff-help">
            It stops, and says why, at every point that needs you: a completion gate or an authorization, a blocked task, a failed, stopped or
            timed-out step, failed verification, the reviewer asking for changes more than {tools?.chain?.maxChangeRequests ?? 2} times, the step cap,
            and a done or approved task (closing, merging, pushing and approving stay yours). A CLI that cannot run stops it; it never swaps in another.
          </p>
          {pairingProblem && <p className="dialog-error">{pairingProblem}</p>}
        </>
      )}
      {tools && (
        <ul className="cli-usability" aria-label="CLI usability">
          {CLIS.map((id) => {
            const t = usability(id);
            return (
              <li key={id} className={t?.available ? 'ok' : 'fail'}>
                {t?.available ? '✓' : '✗'} <strong>{id}</strong>{' '}
                {t?.available ? `usable${t.model ? ` · model ${t.model}` : ''}${t.note ? ` · ${t.note}` : ''}` : `cannot run: ${t?.reason ?? 'not reported by the server'}`}
              </li>
            );
          })}
        </ul>
      )}
      <label className="dialog-label" htmlFor="run-when">{mode === 'chain' ? 'First step starts' : 'When'}</label>
      <select id="run-when" className="form-input" value={when} disabled={busy || Boolean(queued)} onChange={(e) => setWhen(e.target.value as TriggerKind)}>
        {(Object.keys(TRIGGER_LABELS) as TriggerKind[]).map((k) => <option key={k} value={k}>{TRIGGER_LABELS[k]}</option>)}
      </select>
      {when === 'at' && (
        <input id="run-at" aria-label="Start at" type="datetime-local" className="form-input" value={atInput} disabled={busy} onChange={(e) => setAtInput(e.target.value)} />
      )}
      {waitsOnTask && (
        <select id="run-after" aria-label={when === 'after-chain' ? 'After the chain of' : 'After the step of'} className="form-input" value={afterTask} disabled={busy || !tasks} onChange={(e) => setAfterTask(e.target.value)}>
          <option value="">{tasks ? 'Pick a task…' : 'Loading tasks…'}</option>
          {tasks && <option value={taskId}>{taskId} (this task: after its current or next {when === 'after-chain' ? 'chain' : 'step'})</option>}
          {tasks?.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      )}
      <p className="handoff-help">
        {when === 'now' && `Starts at once when a slot is free${tools?.queueCap ? ` (at most ${tools.queueCap} at once on this machine)` : ''}; otherwise it waits in the queue (Command › Operations › Run queue).`}
        {when === 'at' && 'Starts at that time, or later if the queue is full then. The queue only advances while the dashboard runs: a time it missed by more than an hour fails instead of starting late.'}
        {when === 'after' && "Starts when that task's step ends, however it ends (succeeded, failed, stopped, time limit), once the dashboard has verified it; if that task has nothing running or queued, it waits for its next step."}
        {when === 'after-chain' && "Starts when that task's role chain stops, for any reason; if no chain runs on it, it waits for its next chain to start and stop."}
        {when !== 'now' && ' The prompt and worktrees are prepared when it starts, from the task files as they are then.'}
      </p>
      {'error' in trigger && when !== 'now' && <p className="dialog-error">{trigger.error}</p>}
      <p className="handoff-help">
        {CLI_HELP[stepCliNow]}. Runs in the task&apos;s primary worktree{primary ? ` (${primary})` : ''} on this machine,
        writes only in the task&apos;s worktrees and its runs dir, and keeps going if this dialog closes or the dashboard
        restarts{tools?.timeLimitMinutes ? `; stopped and failed after ${tools.timeLimitMinutes} min` : ''}. The dashboard holds the task&apos;s
        lease for the whole step (run-agent.sh is refused meanwhile), then runs the office scripts itself and, only when they pass, commits each
        worktree&apos;s diff on its task branch: local only, never pushed. The agent never commits; a commit of its own fails the step.
      </p>
      {(!active || when !== 'now') && !queued && !chainRunning && (
        <label className="launch-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          {mode === 'chain'
            ? chainConfirmLine({ role, taskId, pairing: chainPairing, cap: chainCap, repos: targets?.map((t) => t.repo) ?? [] })
            : confirmLine({ role, taskId, cli, repos: targets?.map((t) => t.repo) ?? [], trigger })}
        </label>
      )}
      {actionsTarget && createPortal(startButton, actionsTarget)}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {notes.map((n) => <p key={n} className={`handoff-help${/could not fetch/.test(n) ? ' launch-warning' : ''}`} role="status">{n}</p>)}
      {showChain(chain, launch) && <ChainTimeline chain={chain} busy={busy} onStop={() => { submitTo(`${route}/chain/stop`, {}); }} />}
      {queued && <QueuedRun item={queued} onChanged={refresh} />}
      {data?.queueFailed && !error && <QueueFailed item={data.queueFailed} />}
      {launch && <OfficeLaunchStatus launch={launch} busy={busy} onStop={chainRunning ? () => { submitTo(`${route}/chain/stop`, {}); } : stop} />}
      {launch && result && <StepResult result={result} />}
    </section>
  );
}
