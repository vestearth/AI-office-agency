import { navigateTo } from '../../navigation';
import { waitDays } from './officeBlocked';
import type { EscalationCardModel, EscalationLine } from './officeEscalation';

/**
 * The help desk's readout: one clickable line per task (id, where it came from, how long) with the
 * reason as written under it. It is not rendered for an empty room. `data-readout` lets the scene
 * overlay place and show it.
 */
export function EscalationReadout({
  lines,
  selectedTaskId,
  onPick,
}: {
  lines: EscalationLine[];
  selectedTaskId: string | null;
  onPick: (taskId: string) => void;
}) {
  return (
    <div className="o3d-queue o3d-escalation o3d-readout" data-readout="escalation">
      <p className="head">escalated · {lines.length}</p>
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
              <span className="from">{line.from ?? ''}</span>
              <span className="age">{waitDays(line.days)}</span>
              {line.reason && (
                <span className="why">
                  {line.reasonLabel === 'latest note' && <em>latest note · </em>}
                  {line.reason}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the selection card adds for a task in the Escalation room: where it came from, the full
 * reason as written, how long, and the button to the run in Monitor. There is no way to resolve an
 * escalation from here; Monitor is where Earth does that.
 */
export function EscalationBlock({ taskId, card }: { taskId: string; card: EscalationCardModel }) {
  const since = card.days === null ? '' : ` · ${waitDays(card.days)}`;
  return (
    <div className="o3d-wait o3d-escalation-card" data-escalation-block>
      <p className="lead">{card.heading}{since}{card.from ? ` · ${card.from}` : ''}</p>
      {card.reason && (
        <p className="why">
          {card.reasonLabel === 'latest note' && <em>latest note · </em>}
          {card.reason}
        </p>
      )}
      <button type="button" className="form-button" onClick={() => navigateTo('monitor', taskId)}>Open in Monitor</button>
    </div>
  );
}
