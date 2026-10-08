import { execFile } from 'node:child_process';
import path from 'path';
import { promisify } from 'node:util';
import { config } from '../config';
import type { GateEntry, GateView } from '@shared/types';

const execFileAsync = promisify(execFile);
const GRANTS: ReadonlyArray<GateEntry['grant']> = ['available', 'missing', 'unknown', null];

/**
 * Issue #28 Phase 2F: completion gates for the dashboard. The gate rules stay in
 * Ruby (CompletionGuard.gate_view, via scripts/gate-view-json.rb); this only runs
 * the script and checks its output. A drifting TypeScript copy of a safety rule
 * would be worse than a conservative signal (see reviewModel.ts deriveRiskLevel).
 */

/** True when status.yaml has the key at all: a broken value must still be reported. */
export function hasCompletionGates(statusData: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(statusData, 'completion_gates');
}

export function unreadableGateView(problem: string): GateView {
  return {
    readable: false,
    problem,
    finishedPhase: null,
    summary: { total: 0, resolved: 0, passable: 0, byStatus: {} },
    gates: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} is not an object`);
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} is not a boolean`);
  return value;
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} is not a number`);
  return value;
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} is not a string`);
  return value;
}

function strOrNull(value: unknown, field: string): string | null {
  return value === null ? null : str(value, field);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} is not a list`);
  return value.map((item, i) => str(item, `${field}[${i}]`));
}

function stringMap(value: unknown, field: string): Record<string, string> {
  const source = record(value, field);
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, str(item, `${field}.${key}`)]));
}

function parseGateEntry(value: unknown, i: number): GateEntry {
  const gate = record(value, `gates[${i}]`);
  const field = (name: string) => `gates[${i}].${name}`;
  const grant = gate.grant as GateEntry['grant'];
  if (!GRANTS.includes(grant)) throw new Error(`${field('grant')} is not a known grant state`);
  return {
    name: str(gate.name, field('name')),
    status: str(gate.status, field('status')),
    resolved: bool(gate.resolved, field('resolved')),
    waitsOn: stringList(gate.waits_on, field('waits_on')),
    requiresAuthorization: strOrNull(gate.requires_authorization, field('requires_authorization')),
    grant,
    requiresRecord: bool(gate.requires_record, field('requires_record')),
    ran: gate.ran === null ? null : stringMap(gate.ran, field('ran')),
    passable: bool(gate.passable, field('passable')),
    unresolvedReason: strOrNull(gate.unresolved_reason, field('unresolved_reason')),
    detail: str(gate.detail, field('detail')),
  };
}

/** Parses scripts/gate-view-json.rb output; throws on any shape it does not document. */
export function parseGateView(stdout: string): GateView {
  const data = record(JSON.parse(stdout), 'output');
  const summary = record(data.summary, 'summary');
  const byStatus = record(summary.by_status, 'summary.by_status');
  if (!Array.isArray(data.gates)) throw new Error('gates is not a list');
  return {
    readable: bool(data.readable, 'readable'),
    problem: strOrNull(data.problem, 'problem'),
    finishedPhase: strOrNull(data.finished_phase, 'finished_phase'),
    summary: {
      total: num(summary.total, 'summary.total'),
      resolved: num(summary.resolved, 'summary.resolved'),
      passable: num(summary.passable, 'summary.passable'),
      byStatus: Object.fromEntries(Object.entries(byStatus).map(([key, count]) => [key, num(count, `summary.by_status.${key}`)])),
    },
    gates: data.gates.map(parseGateEntry),
  };
}

function failureReason(error: unknown, timeoutMs: number): string {
  const e = error as { code?: unknown; killed?: boolean; signal?: string | null };
  if (e.killed || e.signal === 'SIGTERM') return `timed out after ${timeoutMs} ms`;
  if (e.code === 'ENOENT') return 'ruby not found';
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output too large';
  if (typeof e.code === 'number') return `ruby exited ${e.code}`;
  return 'ruby failed';
}

export class GateViewService {
  constructor(
    private readonly scriptPath: string = path.join(config.aiOfficeRoot, 'scripts', 'gate-view-json.rb'),
    private readonly timeoutMs: number = 5_000,
  ) {}

  /** Never rejects: any failure is an unreadable view, never an empty all-clear. */
  async load(taskDir: string): Promise<GateView> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('ruby', [this.scriptPath, taskDir], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: this.timeoutMs,
      }));
    } catch (error) {
      return unreadableGateView(`gate view unavailable: ${failureReason(error, this.timeoutMs)}`);
    }
    try {
      return parseGateView(stdout);
    } catch (error) {
      return unreadableGateView(`gate view unavailable: unexpected output (${error instanceof Error ? error.message : 'parse error'})`);
    }
  }
}

export const globalGateViews = new GateViewService();
