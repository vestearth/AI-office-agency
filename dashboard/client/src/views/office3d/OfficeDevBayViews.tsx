import { boardCountsText, type BayLine } from './officeDevBay';

/** The small strip next to a task: one cell per gate (as many as the board draws dots), inked when resolved. */
function Cells({ cells }: { cells: boolean[] }) {
  return (
    <span className="strip" aria-hidden="true">
      {cells.map((inked, index) => <i key={index} data-lit={inked ? '1' : undefined} />)}
    </span>
  );
}

/**
 * Dev Bay's readout. The head gives the room's task count and, on the line under it, how many tasks each
 * whiteboard column holds, so a crowded column is exact even when the board shows a stack. Then one line per task:
 * its id, its role (`currentAgent`, as written), one cell per gate and the next gate's name; a second line names
 * what the task waits on. Clicking a line selects the task. `data-readout` lets the scene overlay place and show it.
 */
export function DevBayReadout({
  lines,
  counts,
  selectedTaskId,
  onPick,
}: {
  lines: BayLine[];
  counts: readonly number[];
  selectedTaskId: string | null;
  onPick: (taskId: string) => void;
}) {
  return (
    <div className="o3d-queue o3d-escalation o3d-devbay o3d-readout" data-readout="dev">
      <p className="head">dev bay · {lines.length}</p>
      <p className="head dim counts">{boardCountsText(counts)}</p>
      <ul>
        {lines.map((line) => (
          <li key={line.taskId}>
            <button
              type="button"
              className="o3d-eline o3d-bayline"
              data-on={line.taskId === selectedTaskId ? '1' : undefined}
              data-task={line.taskId}
              aria-pressed={line.taskId === selectedTaskId}
              onClick={() => onPick(line.taskId)}
            >
              <span className="id">{line.taskId}</span>
              <span className="role">{line.role ?? '—'}</span>
              <Cells cells={line.cells} />
              <span className="next">{line.next}</span>
              {line.wait && <span className="why">{line.wait}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
