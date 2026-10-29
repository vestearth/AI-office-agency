import path from 'path';
import { config } from '../config';
import type { AuthorizationGrantsView, AwaitingGrant, GateView, Grantor, RecordedGrant } from '@shared/types';
import { globalGateViews, type GateViewService } from './gateView';
import { readEffectivePrefix, readTeamRegistry } from './identity';
import { ruby, tail } from './officeScripts';

/**
 * Issue #56: record an authorization grant from the dashboard. The ledger rules
 * stay in scripts/record-authorization.rb (task lock, ownership fence, id, `at`,
 * the authorization_recorded meta event). This decides only what the dashboard
 * may ask it for:
 * - an action that a pending gate of the task waits for (grant "missing");
 * - always as the grantor: the office.team.yaml owner of this checkout's task
 *   prefix, which the dashboard's "Your name" field registers. A name sent by
 *   the client is never used;
 * - via "dashboard", so the ledger row says where it came from.
 * The route that calls it is localhost-only (middleware/localOnly.ts).
 */

export type { Grantor } from '@shared/types';
export type GrantResult = ({ ok: true } & RecordedGrant) | { ok: false; status: number; error: string };

const SCOPE_MAX = 200;
const REASON_MAX = 500;
const MAX_EXPIRY_HOURS = 168;

/** Pending bound gates without a valid grant, dependencies or not: an operator may approve a whole chain at once. */
export function awaitingGrants(view: GateView): AwaitingGrant[] {
  if (!view.readable || view.ledgerReadable === false || view.finishedPhase !== null) return [];
  return view.gates
    .filter((gate) => gate.status === 'pending' && gate.requiresAuthorization !== null && gate.grant === 'missing')
    .map((gate) => ({ gate: gate.name, action: gate.requiresAuthorization as string }));
}

function gateProblem(taskId: string, view: GateView): string | null {
  if (!view.readable) return `The gate state of ${taskId} cannot be read: ${view.problem ?? 'unknown problem'}.`;
  if (view.ledgerReadable === false) return `The gate state of ${taskId} cannot be read: the authorization ledger cannot be read.`;
  if (view.finishedPhase !== null) return `${taskId} is ${view.finishedPhase}: its gates cannot change.`;
  return null;
}

export async function resolveGrantor(officeRoot: string): Promise<Grantor> {
  const { taskPrefix } = await readEffectivePrefix(officeRoot);
  if (!taskPrefix) return { actor: null, problem: 'This checkout has no task prefix. Set your name in the dashboard first.' };
  const owner = (await readTeamRegistry(officeRoot))[taskPrefix];
  if (!owner) return { actor: null, problem: `Task prefix ${taskPrefix} has no owner in office.team.yaml. Set your name in the dashboard first.` };
  return { actor: owner, prefix: taskPrefix };
}

function oneLine(value: unknown, field: string, max: number): string | { error: string } {
  if (typeof value !== 'string' || !value.trim()) return { error: `${field} must be a non-empty string` };
  const text = value.trim();
  if (text.length > max) return { error: `${field} exceeds ${max} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return { error: `${field} must be one line of text` };
  return text;
}

/** The ledger's timestamp form: UTC, whole seconds. */
const ledgerTime = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

export class AuthorizationGrants {
  constructor(
    private readonly officeRoot: string = config.aiOfficeRoot,
    private readonly runsDir: string = config.runsDir,
    private readonly gateViews: Pick<GateViewService, 'load'> = globalGateViews,
    private readonly grantor: () => Promise<Grantor> = () => resolveGrantor(officeRoot),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async view(taskId: string): Promise<AuthorizationGrantsView> {
    const gates = await this.gateViews.load(path.join(this.runsDir, taskId));
    return { taskId, awaiting: awaitingGrants(gates), problem: gateProblem(taskId, gates), grantor: await this.grantor() };
  }

  async record(taskId: string, input: Record<string, unknown>): Promise<GrantResult> {
    const refuse = (status: number, error: string): GrantResult => ({ ok: false, status, error });
    const action = typeof input.action === 'string' && input.action.trim() ? input.action.trim() : null;
    if (!action) return refuse(400, 'action must be a non-empty string');
    const scope = oneLine(input.scope, 'scope', SCOPE_MAX);
    if (typeof scope !== 'string') return refuse(400, scope.error);
    const reason = oneLine(input.reason, 'reason', REASON_MAX);
    if (typeof reason !== 'string') return refuse(400, reason.error);
    const hours = input.expiresInHours;
    if (hours !== undefined && hours !== null
      && !(typeof hours === 'number' && Number.isInteger(hours) && hours >= 1 && hours <= MAX_EXPIRY_HOURS)) {
      return refuse(400, `expiresInHours must be a whole number of hours from 1 to ${MAX_EXPIRY_HOURS}`);
    }

    const grantor = await this.grantor();
    if (grantor.actor === null) return refuse(409, grantor.problem);

    const gates = await this.gateViews.load(path.join(this.runsDir, taskId));
    const problem = gateProblem(taskId, gates);
    if (problem) return refuse(409, problem);
    if (!awaitingGrants(gates).some((awaiting) => awaiting.action === action)) {
      return refuse(409, `No pending gate of ${taskId} waits for a ${action} grant.`);
    }

    const expiresAt = typeof hours === 'number' ? ledgerTime(new Date(this.clock().getTime() + hours * 3_600_000)) : null;
    const args = [taskId, 'grant', '--action', action, '--scope', scope, '--actor', grantor.actor, '--via', 'dashboard', '--reason', reason,
      ...(expiresAt ? ['--expires-at', expiresAt] : [])];
    const result = await ruby(this.officeRoot, 'scripts/record-authorization.rb', args, { env: { AI_OFFICE_RUNS_DIR: this.runsDir } });
    const id = /^(authz-\d+) grant$/m.exec(result.stdout)?.[1];
    if (result.code === 0 && id) return { ok: true, id, action, actor: grantor.actor, expiresAt };

    const detail = tail(result.stderr || result.stdout, 5, 600) || `record-authorization.rb exited ${result.code}`;
    // 9: the ownership fence (usually a running step holds the task); 2/3: the writer refused this append or the task's files.
    if (result.code === 9) return refuse(409, `The ownership fence of ${taskId} refused the grant: ${detail}`);
    return refuse(result.code === 2 || result.code === 3 ? 409 : 500, detail);
  }
}

export const globalAuthorizationGrants = new AuthorizationGrants();
