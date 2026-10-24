import { navigateTo } from '../../navigation';
import type { ReadoutLine, ReviewReadout } from './officeReview';

function Line({ line, selected, onPick }: { line: ReadoutLine; selected: boolean; onPick: (taskId: string) => void }) {
  return (
    <li>
      <button
        type="button"
        className="o3d-qline"
        data-on={selected ? '1' : undefined}
        data-task={line.taskId}
        aria-pressed={selected}
        onClick={() => onPick(line.taskId)}
      >
        <span className="id">{line.taskId}</span>
        <span className="what">{line.detail}</span>
        <span className="age" />
        {line.badge && <span className="room o3d-badge">{line.badge}</span>}
      </button>
    </li>
  );
}

/**
 * The inspection line's readout: every task waiting for a decision (oldest first, with its age and an
 * `over Nd` badge), the decided ones, then the tasks that are not waiting for a decision. Clicking a
 * line selects the task; a waiting or decided one also opens the decision panel (the host decides).
 * `data-readout` lets the scene overlay place and show it.
 */
export function ReviewReadoutView({
  readout,
  selectedTaskId,
  onPick,
}: {
  readout: ReviewReadout;
  selectedTaskId: string | null;
  onPick: (taskId: string) => void;
}) {
  return (
    <div className="o3d-queue o3d-readout" data-review-readout data-readout="review">
      <p className="head">{readout.header}</p>
      <ul>
        {[...readout.waiting, ...readout.decided].map((line) => (
          <Line key={line.taskId} line={line} selected={line.taskId === selectedTaskId} onPick={onPick} />
        ))}
      </ul>
      {readout.othersHeading && (
        <>
          <p className="head dim">{readout.othersHeading}</p>
          <ul className="dim">
            {readout.others.map((line) => (
              <Line key={line.taskId} line={line} selected={line.taskId === selectedTaskId} onPick={onPick} />
            ))}
          </ul>
        </>
      )}
      {readout.footer && <p className="head dim">{readout.footer}</p>}
    </div>
  );
}

/**
 * What the selection card adds for a task in the Review room: the button that opens the decision panel
 * for a task waiting for (or already given) a decision, or Open in Monitor for any other kind. Open in
 * Monitor appears once: `showMonitor` is false when another block on the card already carries it.
 */
export function ReviewBlock({
  taskId,
  decides,
  onDecide,
  showMonitor,
}: {
  taskId: string;
  decides: boolean;
  onDecide: () => void;
  showMonitor: boolean;
}) {
  if (!decides && !showMonitor) return null;
  return (
    <div className="o3d-wait" data-review-block>
      {decides ? (
        <button type="button" className="form-button" onClick={onDecide} aria-label={`Review and decide ${taskId}`}>Review &amp; decide</button>
      ) : (
        <button type="button" className="form-button" onClick={() => navigateTo('monitor', taskId)}>Open in Monitor</button>
      )}
    </div>
  );
}
