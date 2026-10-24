import { navigateTo } from '../../navigation';
import type { DebugCardModel, DebugLine } from './officeDebug';

/** The `round N` badge. A looping task (round 3 on) is highlighted. Round 0 or unknown has none. */
function RoundBadge({ rounds, looping }: { rounds: number | null; looping: boolean }) {
  if (rounds === null) return null;
  return <b className="o3d-round" data-loop={looping ? '1' : undefined}>round {rounds}</b>;
}

/**
 * The clinic's readout: one clickable line per task (id, who sent it back, how long, the round badge)
 * with the reason as written under it. It is not rendered for an empty room. `data-readout` lets the
 * scene overlay place and show it.
 */
export function DebugReadout({
  lines,
  selectedTaskId,
  onPick,
}: {
  lines: DebugLine[];
  selectedTaskId: string | null;
  onPick: (taskId: string) => void;
}) {
  return (
    <div className="o3d-queue o3d-debug o3d-readout" data-readout="debug">
      <p className="head">debugging · {lines.length}</p>
      <ul>
        {lines.map((line) => (
          <li key={line.taskId}>
            <button
              type="button"
              className="o3d-eline"
              data-on={line.taskId === selectedTaskId ? '1' : undefined}
              data-task={line.taskId}
              aria-pressed={line.taskId === selectedTaskId}
              onClick={() => onPick(line.taskId)}
            >
              <span className="id">{line.taskId}</span>
              <span className="from"><RoundBadge rounds={line.rounds} looping={line.looping} />{line.who ?? ''}</span>
              <span className="age">{line.age ?? '—'}</span>
              {line.reason && <span className="why">{line.reason}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the selection card adds for a task in Debug Lab: the round badge, how long, who sent it back,
 * the full reason as written, and the button to the run in Monitor.
 */
export function DebugBlock({ taskId, card }: { taskId: string; card: DebugCardModel }) {
  return (
    <div className="o3d-wait o3d-debug-card" data-debug-block>
      <p className="lead">
        {card.heading} <RoundBadge rounds={card.rounds} looping={card.looping} />{card.age ? ` · ${card.age}` : ''}
      </p>
      {card.who && <p>{card.who}</p>}
      {card.reason && <p className="why">{card.reason}</p>}
      <button type="button" className="form-button" onClick={() => navigateTo('monitor', taskId)}>Open in Monitor</button>
    </div>
  );
}
