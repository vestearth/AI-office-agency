import { Play } from 'lucide-react';
import type { TaskLaunchResponse } from '../../../shared/types';
import { chainPolling, showChain } from './chain';
import { ChainTimeline } from './ChainTimeline';
import { isActive } from './officeLaunch';
import { OfficeLaunchStatus, StepResult, useOfficeLaunch } from './OfficeLaunchStatus';
import { QueuedRun, QueueFailed } from './RunQueuePanel';
import { handoffLine } from './startTask';

// Monitor › run detail › Launch: the newest Run on this task, running or finished, with
// what the server did after it (office scripts, agent-commit check, its commit), a Run
// of it waiting in the queue (D13, with Cancel) or one that could not start, the task's
// role chain (D12: its timeline and why it stopped, with Stop chain while it runs), and
// the newest Open hand-off (D15: the task shows it was opened). Hidden when there is none
// of these (or the viewer is not on localhost, where /api/launch answers 403). It re-reads
// every 15 s, so a step started from the Start dialog shows up without a reload, and
// every 3 s while the step is being verified, a Run waits in the queue or a chain runs.
export function LaunchCard({ taskId }: { taskId: string }) {
  const route = `/api/launch/task/${encodeURIComponent(taskId)}`;
  const { data, launch, busy, stop, refresh, submitTo } = useOfficeLaunch<TaskLaunchResponse>(route, {
    idlePollMs: 15_000, keepPolling: (d) => d.result?.state === 'verifying' || Boolean(d.queued) || chainPolling(d.chain),
  });
  const handoff = data?.lastHandoff;
  const queued = data?.queued;
  const queueFailed = data?.queueFailed;
  const chain = showChain(data?.chain, launch) ? data!.chain! : undefined;
  if (!launch && !handoff && !queued && !queueFailed && !chain) return null;
  const result = launch && !isActive(launch) ? data?.result : undefined;
  const stopChain = () => { submitTo(`${route}/chain/stop`, {}); };
  return (
    <div className="card monitor-section-card launch-card">
      <div className="panel-heading"><Play size={14} /> <span>Launch</span>{(queued?.step?.role ?? launch?.role) && <span className="flow-scope">{queued?.step?.role ?? launch?.role}</span>}</div>
      {chain && <ChainTimeline chain={chain} busy={busy} onStop={stopChain} />}
      {queued && <QueuedRun item={queued} onChanged={refresh} />}
      {queueFailed && <QueueFailed item={queueFailed} />}
      {launch && <OfficeLaunchStatus launch={launch} busy={busy} onStop={chain?.active ? stopChain : stop} />}
      {result && <StepResult result={result} />}
      {handoff && <p className="handoff-help" title={handoff.worktree}>{handoffLine(handoff)}</p>}
    </div>
  );
}
