import React from 'react';
import { runStatusLabel } from '../../../../shared/statusLabels';
import { ZONES, ZONE_BY_ID, summarizeZones, zoneTone } from '../commandZones';
import { roomStatLinesFor } from './officeRoomStats';
import type { FlowPhaseWait } from '../../../../shared/types';
import {
  desksForZone,
  describeOfficeSelection,
  sceneDesks,
  selectionDomId,
  type OfficeSelection,
  type OfficeTask,
  type OfficeZoneStats,
} from './officeSelection';

export function OfficeRoomList({
  tasks,
  stats,
  selection,
  onSelect,
}: {
  tasks: OfficeTask[];
  stats: OfficeZoneStats;
  selection: OfficeSelection | null;
  onSelect: (next: OfficeSelection) => void;
}) {
  const deskVisible = selection?.kind === 'desk'
    && sceneDesks(desksForZone(selection.zoneId, tasks, stats)).some((desk) => desk.taskId === selection.taskId);
  const fallbackRoomId = selection?.kind === 'desk' && !deskVisible
    ? (ZONES.some((zone) => zone.id === selection.zoneId) ? selection.zoneId : ZONES[0].id)
    : selection == null
      ? ZONES[0].id
      : null;
  return (
    <div role="group" aria-label="Rooms and desks">
      <p className="o3d-help">Choose a room or desk. Arrow keys move between rooms and desks.</p>
      {ZONES.map((zone) => {
        const stat = stats.get(zone.id);
        const tone = zoneTone(zone, stat ?? { count: 0, attention: false, active: false });
        const roomOn = selection?.kind === 'room' && selection.zoneId === zone.id;
        const desks = sceneDesks(desksForZone(zone.id, tasks, stats));
        const roomTab = roomOn || zone.id === fallbackRoomId;
        return (
          <div className="o3d-zone" key={zone.id}>
            <button
              type="button"
              id={selectionDomId({ kind: 'room', zoneId: zone.id })}
              className={roomOn ? 'on' : ''}
              aria-pressed={roomOn}
              tabIndex={roomTab ? 0 : -1}
              onClick={() => onSelect({ kind: 'room', zoneId: zone.id })}
            >
              <i className="o3d-swatch" style={{ background: tone }} />
              <span>{zone.label}</span>
              <span className="o3d-count">{stat?.count ?? 0}</span>
            </button>
            <div className="o3d-desks">
              {desks.map((desk) => {
                const deskOn = selection?.kind === 'desk'
                  && selection.zoneId === zone.id
                  && selection.taskId === desk.taskId;
                return (
                  <button
                    type="button"
                    key={desk.key}
                    id={selectionDomId({ kind: 'desk', zoneId: zone.id, taskId: desk.taskId })}
                    className={deskOn ? 'on' : ''}
                    aria-pressed={deskOn}
                    tabIndex={deskOn ? 0 : -1}
                    onClick={() => onSelect({ kind: 'desk', zoneId: zone.id, taskId: desk.taskId })}
                  >
                    <span>{desk.task?.taskId ?? 'Empty desk'}</span>
                    {desk.task && <span className="o3d-mini">{runStatusLabel(desk.task.status, desk.task.phase)}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OfficeDetail({
  tasks,
  stats,
  selection,
  waits = [],
}: {
  tasks: OfficeTask[];
  stats?: OfficeZoneStats;
  selection: OfficeSelection | null;
  waits?: readonly FlowPhaseWait[];
}) {
  const detail = describeOfficeSelection(selection, tasks, stats);
  const zone = selection ? ZONE_BY_ID.get(selection.zoneId) : undefined;
  const zoneStats = stats ?? summarizeZones(tasks);
  const lines = selection ? roomStatLinesFor(selection.zoneId, tasks, zoneStats, waits) : [];
  return (
    <section aria-live="polite" aria-label="Selected office item">
      <h2>{detail.heading}</h2>
      {zone && <p className="o3d-kind">{selection?.kind === 'desk' ? 'Desk' : 'Room'} · {zone.kind}</p>}
      {lines.length > 0 && (
        <dl className="o3d-stats">
          {lines.map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd style={{ color: line.tone ?? '#e6edf5' }}>{line.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {detail.tasks.length === 0 ? (
        <p className="o3d-empty">{detail.emptyLabel}</p>
      ) : (
        <ul>
          {detail.tasks.map((task) => (
            <li key={task.taskId}>
              <strong>{task.taskId}</strong>
              <span className="o3d-title">{task.title}</span>
              <span className="o3d-status">{task.statusLabel}</span>
              <span className="o3d-phase">{task.phaseLabel}</span>
              <span className="o3d-operator">last operator: {task.operator}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
