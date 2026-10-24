import { navigateTo } from '../../navigation';
import { CommandCopy } from '../CommandCopy';
import { waitDays, type WaitCardModel, type WaitLine, type WaitQueue } from './officeBlocked';

function QueueLine({ line, selected, onPick }: { line: WaitLine; selected: boolean; onPick: (taskId: string) => void }) {
  return (
    <li>
      <button
        type="button"
        className="o3d-qline"
        data-on={selected ? '1' : undefined}
        data-task={line.taskId}
        aria-pressed={selected}
        style={{ paddingLeft: 4 + line.depth * 10 }}
        onClick={() => onPick(line.taskId)}
      >
        <span className="id">{line.taskId}</span>
        <span className="what">{line.label}</span>
        <span className="age">{waitDays(line.days)}</span>
        {line.roomTag && <span className="room">{line.roomTag}</span>}
      </button>
    </li>
  );
}

/**
 * The waiting room's readout: who waits on Earth (every room), then who waits on others. One line
 * per task. Clicking a line selects the task. `data-readout` lets the scene overlay place and show it.
 */
export function BlockedReadout({
  queue,
  selectedTaskId,
  onPick,
}: {
  queue: WaitQueue;
  selectedTaskId: string | null;
  onPick: (taskId: string) => void;
}) {
  return (
    <div className="o3d-queue o3d-readout" data-blocked-readout data-readout="blocked">
      <p className="head">waiting on you · {queue.earth.length}</p>
      <ul>
        {queue.earth.map((line) => (
          <QueueLine key={line.taskId} line={line} selected={line.taskId === selectedTaskId} onPick={onPick} />
        ))}
      </ul>
      {queue.others.length > 0 && (
        <>
          <p className="head dim">waiting on others · {queue.others.length}</p>
          <ul className="dim">
            {queue.others.map((line) => (
              <QueueLine key={line.taskId} line={line} selected={line.taskId === selectedTaskId} onPick={onPick} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * What the selection card adds for a waiting task, in any room: how long and on what, the task's own
 * command to copy (never the dashboard running it), a button to the task it waits on, or the plain
 * fact that no command is recorded. Open in Monitor is always there.
 */
export function WaitBlock({
  taskId,
  card,
  onGoTo,
}: {
  taskId: string;
  card: WaitCardModel;
  onGoTo: (taskId: string) => void;
}) {
  const since = card.days === null ? '' : ` · ${waitDays(card.days)}`;
  return (
    <div className="o3d-wait" data-wait-block>
      <p className="lead">{card.heading}{since}{card.detail ? ` · ${card.detail}` : ''}</p>
      {card.command && <CommandCopy command={card.command} />}
      {card.goTo && (
        <p className="chain">
          Waiting on {card.goTo}
          <button type="button" className="form-button" onClick={() => onGoTo(card.goTo!)}>Go to {card.goTo}</button>
        </p>
      )}
      {!card.command && !card.goTo && <p>No command recorded for this wait</p>}
      <button type="button" className="form-button" onClick={() => navigateTo('monitor', taskId)}>Open in Monitor</button>
    </div>
  );
}
