import { Play } from 'lucide-react';
import type { TaskLaunchResponse } from '../../../shared/types';
import { isActive } from './officeLaunch';
import { LaunchContract, OfficeLaunchStatus, useOfficeLaunch } from './OfficeLaunchStatus';

// Monitor › run detail › Launch: the newest Start-button step on this task, running
// or finished, with the server's contract check. Hidden when there is none (or the
// viewer is not on localhost, where /api/launch answers 403).
export function LaunchCard({ taskId }: { taskId: string }) {
  const { data, launch, busy, stop } = useOfficeLaunch<TaskLaunchResponse>(`/api/launch/task/${encodeURIComponent(taskId)}`);
  if (!launch) return null;
  const contract = !isActive(launch) ? data?.contract : undefined;
  return (
    <div className="card monitor-section-card launch-card">
      <div className="panel-heading"><Play size={14} /> <span>Launch</span>{launch.role && <span className="flow-scope">{launch.role}</span>}</div>
      <OfficeLaunchStatus launch={launch} busy={busy} onStop={stop} />
      {contract && <LaunchContract contract={contract} />}
    </div>
  );
}
