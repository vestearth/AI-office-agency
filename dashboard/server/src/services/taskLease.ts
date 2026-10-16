import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { RUBY, ruby } from './officeScripts';

// D6/D8: the task's ownership lease, taken through the office's own mechanism
// (scripts/task-ownership.rb, docs/task-ownership.md), so a dashboard step fences
// run-agent.sh (its ownership_acquire is refused, exit 9) and every status writer that
// calls the fence. The dashboard holds it for the whole step, from before the
// worktrees are made until verification and the commit are done, and releases it on
// every ending (success, failure, Stop, time limit, lost).
//
// Recovery is the office's own: a lease lapses lease_seconds (office.config.yaml,
// 1800 s) after its last renewal, and the next acquire reclaims it, archiving the old
// holder. Renewal comes from the step's detached wrapper (the heartbeat: renewArgv
// every renew_interval_seconds while the CLI is alive), so it survives a dashboard
// restart and stops when the process is gone, exactly like run-agent.sh's renewer.

const SCRIPT = 'scripts/task-ownership.rb';

export interface LeaseHolder { runId: string; agent: string | null; expiresAt: string; live: boolean; epoch: number }

/** A lease the dashboard holds for one step (or, with ownership disabled in the office config, the record that none was taken). */
export interface LeaseGrant {
  taskDir: string;
  runId: string;
  /** The fencing token every fenced script of this step presents; null when ownership is disabled. */
  epoch: number | null;
  disabled: boolean;
  leaseSeconds: number;
  renewIntervalSeconds: number;
  message: string;
}

export class LeaseRefusedError extends Error {
  readonly status = 409;
}

export class TaskLease {
  constructor(readonly officeRoot: string) {}

  /** The current holder from runs/<TASK>/ownership.yaml, or null when nobody holds the task. */
  holder(taskDir: string): LeaseHolder | null {
    let record: { epoch?: number; holder?: { run_id?: string; agent?: string | null; lease_expires_at?: unknown } | null } | null;
    try { record = yaml.load(fs.readFileSync(path.join(taskDir, 'ownership.yaml'), 'utf8')) as typeof record; } catch { return null; }
    const h = record?.holder;
    if (!h?.run_id || !h.lease_expires_at) return null;
    // js-yaml reads an unquoted ISO timestamp as a Date.
    const expires = h.lease_expires_at instanceof Date ? h.lease_expires_at.toISOString().replace(/\.000Z$/, 'Z') : String(h.lease_expires_at);
    return { runId: h.run_id, agent: h.agent ?? null, expiresAt: expires, live: Date.parse(expires) > Date.now(), epoch: Number(record?.epoch ?? 0) };
  }

  private async config(taskDir: string) {
    const out = await ruby(this.officeRoot, SCRIPT, ['config', taskDir]);
    const value = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(out.stdout)?.[1]?.trim();
    if (out.code !== 0) throw new LeaseRefusedError(`The office ownership config is unreadable: ${(out.stderr || out.stdout).trim()}`);
    return { enabled: value('enabled') !== 'false', leaseSeconds: Number(value('lease_seconds')) || 1800, renewIntervalSeconds: Number(value('renew_interval_seconds')) || 300 };
  }

  /** Takes the lease for runId, or throws LeaseRefusedError with the holder and the reason (exit 9). */
  async acquire(taskDir: string, taskId: string, input: { runId: string; agent: string; worktree?: string; reason: string }): Promise<LeaseGrant> {
    const cfg = await this.config(taskDir);
    const args = ['acquire', taskDir, taskId, `run_id=${input.runId}`, `agent=${input.agent}`, `reason=${input.reason}`];
    // Informational: worktree exclusivity is off in the office config by default.
    args.push(`worktree=${input.worktree ?? ''}`);
    const out = await ruby(this.officeRoot, SCRIPT, args);
    const message = (out.stdout || out.stderr).trim();
    if (out.code === 9) throw new LeaseRefusedError((out.stderr || out.stdout).replace(/^\[ownership\]\s*/, '').trim());
    if (out.code !== 0) throw Object.assign(new Error(`Could not take the task lease (exit ${out.code}): ${(out.stderr || out.stdout).trim()}`), { status: 500 });
    if (!cfg.enabled || /ownership disabled/.test(out.stdout)) {
      return { taskDir, runId: input.runId, epoch: null, disabled: true, leaseSeconds: cfg.leaseSeconds, renewIntervalSeconds: cfg.renewIntervalSeconds, message };
    }
    const epoch = Number(/epoch=(\d+)/.exec(out.stdout)?.[1]);
    if (!Number.isInteger(epoch)) throw Object.assign(new Error(`task-ownership.rb granted no epoch: ${message}`), { status: 500 });
    return { taskDir, runId: input.runId, epoch, disabled: false, leaseSeconds: cfg.leaseSeconds, renewIntervalSeconds: cfg.renewIntervalSeconds, message };
  }

  /** Extends the lease while this run still holds it; ok false (with the reason) once it was lost. */
  async renew(grant: LeaseGrant): Promise<{ ok: boolean; message: string }> {
    if (grant.disabled) return { ok: true, message: 'ownership disabled in the office config: no lease to renew' };
    const out = await ruby(this.officeRoot, SCRIPT, ['renew', grant.taskDir, `run_id=${grant.runId}`]);
    return { ok: out.code === 0, message: (out.code === 0 ? out.stdout : out.stderr || out.stdout).replace(/^\[ownership\]\s*/, '').trim() };
  }

  /** Releases the lease if this run holds it (holder-only, never force). */
  async release(grant: LeaseGrant, reason: string): Promise<{ ok: boolean; message: string }> {
    if (grant.disabled) return { ok: true, message: 'ownership disabled in the office config: no lease was taken' };
    const out = await ruby(this.officeRoot, SCRIPT, ['release', grant.taskDir, `run_id=${grant.runId}`, `reason=${reason}`]);
    return { ok: out.code === 0, message: (out.code === 0 ? out.stdout : out.stderr || out.stdout).replace(/^\[ownership\]\s*/, '').trim() };
  }

  /** What the step's detached wrapper runs every renew_interval_seconds while the CLI is alive. */
  renewArgv(grant: LeaseGrant): string[] {
    return [RUBY, path.join(this.officeRoot, SCRIPT), 'renew', grant.taskDir, `run_id=${grant.runId}`];
  }

  /** The credentials run-agent.sh exports to its fenced writers: run id and epoch, or the office kill switch when ownership is off. */
  fencedEnv(grant: LeaseGrant): Record<string, string> {
    return grant.disabled
      ? { AI_DEV_OFFICE_RUN_ID: grant.runId, AI_DEV_OFFICE_OWNERSHIP: 'off' }
      : { AI_DEV_OFFICE_RUN_ID: grant.runId, AI_DEV_OFFICE_OWNERSHIP_EPOCH: String(grant.epoch) };
  }
}
