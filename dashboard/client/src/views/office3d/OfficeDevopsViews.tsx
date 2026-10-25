import { navigateTo } from '../../navigation';
import { BOARD_SEGMENTS, trainText, type TrainRow } from './officeDevops';
import { EscalationList } from './OfficeEscalationViews';
import type { EscalationLine } from './officeEscalation';
import type { GateItem } from './officeDevBay';

type TaskLine = Omit<EscalationLine, 'kind'>;

/** The small strip next to a train: one cell per gate (as many as the board draws), lit when resolved. */
function Strip({ row }: { row: TrainRow }) {
  if (row.state !== 'gates') return <span className="strip" aria-hidden="true" />;
  return (
    <span className="strip" aria-hidden="true">
      {Array.from({ length: Math.min(row.total, BOARD_SEGMENTS) }, (_, index) => (
        <i key={index} data-lit={index < row.lit ? '1' : undefined} />
      ))}
    </span>
  );
}

/**
 * The deploy control room's readout, in two parts. The head lists what DevOps is handling (shown only
 * while the room holds a task). `release trains` lists every open train with a small segment strip and
 * its exact `gates x/y`, and shows even when the room is empty. `data-readout` lets the scene overlay
 * place and show it.
 */
export function DevopsReadout({
  lines,
  trains,
  selectedTaskId,
  onPick,
}: {
  lines: TaskLine[];
  trains: TrainRow[];
  selectedTaskId: string | null;
  onPick: (taskId: string) => void;
}) {
  return (
    <div className="o3d-queue o3d-escalation o3d-devops o3d-readout" data-readout="devops">
      {lines.length > 0 && (
        <>
          <p className="head">devops · {lines.length}</p>
          <EscalationList lines={lines} selectedTaskId={selectedTaskId} onPick={onPick} />
        </>
      )}
      <p className="head">release trains · {trains.length}</p>
      <ul>
        {trains.map((row) => (
          <li key={row.taskId}>
            <button
              type="button"
              className="o3d-eline o3d-train"
              data-on={row.taskId === selectedTaskId ? '1' : undefined}
              data-task={row.taskId}
              aria-pressed={row.taskId === selectedTaskId}
              onClick={() => onPick(row.taskId)}
            >
              <span className="id">{row.taskId}</span>
              <Strip row={row} />
              <span className="gates">{trainText(row)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the selection card adds for a task's gates: its exact `gates x/y`, then the gates in order with their state
 * (pass, na or pending) when the list is known, and the button to the run in Monitor. It serves every open release
 * train, in any room, and every task in Dev Bay that has gates. A card that already carries Open in Monitor (a
 * DevOps task's own block) passes `showMonitor={false}`.
 */
export function GatesBlock({
  taskId,
  text,
  items = [],
  showMonitor = true,
}: {
  taskId: string;
  text: string;
  items?: GateItem[];
  showMonitor?: boolean;
}) {
  return (
    <div className="o3d-wait o3d-gates-card" data-gates-block>
      <p className="lead">{text}</p>
      {items.length > 0 && (
        <ol className="o3d-gate-list" aria-label="Gates in order">
          {items.map((item) => (
            <li key={item.name} data-state={item.status}>
              <span className="name">{item.name}</span>
              <span className="state">{item.status}</span>
            </li>
          ))}
        </ol>
      )}
      {showMonitor && <button type="button" className="form-button" onClick={() => navigateTo('monitor', taskId)}>Open in Monitor</button>}
    </div>
  );
}
