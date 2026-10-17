import { Play } from 'lucide-react';
import type { TaskLaunchResponse } from '../../../shared/types';
import { isActive } from './officeLaunch';
import { OfficeLaunchStatus, StepResult, useOfficeLaunch } from './OfficeLaunchStatus';
import { QueuedRun, QueueFailed } from './RunQueuePanel';
import { handoffLine } from './startTask';

// Monitor › run detail › Launch: the newest Run on this task, running or finished, with
// what the server did after it (office scripts, agent-commit check, its commit), a Run
// of it waiting in the queue (D13, with Cancel) or one that could not start, and the
// newest Open hand-off (D15: the task shows it was opened). Hidden when there is none of
// these (or the viewer is not on localhost, where /api/launch answers 403). It re-reads
// every 15 s, so a step started from the Start dialog shows up without a reload, and
// every 3 s while the step is being verified or a Run waits in the queue.
export function LaunchCard({ taskId }: { taskId: string }) {
  const { data, launch, busy, stop, refresh } = useOfficeLaunch<TaskLaunchResponse>(`/api/launch/task/${encodeURIComponent(taskId)}`, {
    idlePollMs: 15_000, keepPolling: (d) => d.result?.state === 'verifying' || Boolean(d.queued),
  });
  const handoff = data?.lastHandoff;
  const queued = data?.queued;
  const queueFailed = data?.queueFailed;
  if (!launch && !handoff && !queued && !queueFailed) return null;
  const result = launch && !isActive(launch) ? data?.result : undefined;
  return (
    <div className="card monitor-section-card launch-card">
      <div className="panel-heading"><Play size={14} /> <span>Launch</span>{(queued?.step?.role ?? launch?.role) && <span className="flow-scope">{queued?.step?.role ?? launch?.role}</span>}</div>
      {queued && <QueuedRun item={queued} onChanged={refresh} />}
      {queueFailed && <QueueFailed item={queueFailed} />}
      {launch && <OfficeLaunchStatus launch={launch} busy={busy} onStop={stop} />}
      {result && <StepResult result={result} />}
      {handoff && <p className="handoff-help" title={handoff.worktree}>{handoffLine(handoff)}</p>}
    </div>
  );
}
