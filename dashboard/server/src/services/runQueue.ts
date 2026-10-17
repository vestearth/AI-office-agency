import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { OfficeLaunch, RunQueueItem, RunQueueView, RunTrigger } from '../../../shared/types';
import { AT_MISSED_GRACE_MS } from '../../../shared/runQueue';

// D13: one file-backed queue for every Run (task steps from the Start dialog and the
// knowledge re-check's rounds). A server timer advances it (tick), so it only moves
// while the dashboard runs; the file survives a restart.
//
// Each tick, in order:
//   1. an item left `starting` by a dashboard that stopped mid-start becomes `started`
//      when its pre-assigned launch exists, else `failed` (interrupted);
//   2. a time trigger first seen due more than AT_MISSED_GRACE_MS late was missed (the
//      dashboard was not running then): `failed`, never started hours later;
//   3. an after trigger whose step will never run (its queued item failed, was cancelled
//      or skipped) fails with that reason;
//   4. while fewer than `cap` launches run (every running launch on this machine, plus
//      items being started), the oldest ready item starts: its trigger fired and no
//      dashboard step of its task (or knowledge round) is running or being verified
//      (one step at a time per task, D8; such an item keeps waiting). Starting decides the
//      prompt, worktrees and argv then (the starter); it can still refuse (the task's
//      lease held by another holder, the CLI unusable, the task gone): the item is then
//      `failed` with the reason, never retried.
//
// An after trigger fires when the other task's step ends: any ending (succeeded, failed,
// time limit, stopped, lost) once the dashboard's verification of it is done, so the
// next step reads the synced status. "Its step" is resolved at enqueue: the other task's
// waiting queue item, else its step in flight, else the next step that starts on it.
// After a chain ends arrives with chains (slice 6): a `chainEnded` probe.
//
// Writes are atomic (temp file + rename) and every change is read-modify-write in one
// synchronous step, so an enqueue or a cancel during a start (which awaits) is kept.

/** Why a new step on this key must wait now (a dashboard step running or being verified); null when free. */
export type BusyProbe = (key: string) => string | null;

export interface QueueLaunches {
  get(id: string): OfficeLaunch | null;
  latest(key: string): OfficeLaunch | null;
  active(): OfficeLaunch[];
}

/** What a starter returns: the launch, and whatever the caller should see beyond it (lease, worktree notes). */
export interface StartOutcome { launch: OfficeLaunch; detail?: Record<string, unknown> }

export interface RunQueueDeps {
  launches: QueueLaunches;
  busy: BusyProbe;
  /** The launch ended but the dashboard is still verifying it (task steps). */
  verifying: (launchId: string) => boolean;
  /** Starts the item (its launchId is pre-assigned); null: nothing to do (an empty knowledge brief). Throws with the reason it cannot. */
  start: (item: RunQueueItem) => Promise<StartOutcome | null>;
  cap: number;
  now?: () => Date;
  newLaunchId?: () => string;
}

export interface EnqueueInput {
  kind: RunQueueItem['kind'];
  key: string;
  label: string;
  trigger: RunTrigger;
  step?: RunQueueItem['step'];
  round?: RunQueueItem['round'];
}

interface QueueFile { version: 1; items: RunQueueItem[] }

const OPEN_STATES = ['waiting', 'starting'];
const KEEP_ENDED = 50;
const RECENT = 10;

export class QueueRefusedError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

const isRunning = (l: OfficeLaunch | null) => Boolean(l && ['running', 'stopping'].includes(l.status));

export class RunQueue {
  private readonly now: () => Date;
  private readonly newLaunchId: () => string;
  /** Items this process is starting right now (a `starting` item outside this set was interrupted). */
  private readonly startingNow = new Set<string>();
  /** The last start's detail per item, for the request that enqueued it. Not persisted. */
  private readonly details = new Map<string, Record<string, unknown>>();
  private chain: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;

  constructor(readonly file: string, private readonly deps: RunQueueDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newLaunchId = deps.newLaunchId ?? (() => `${this.now().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`);
  }

  get cap() { return this.deps.cap; }

  private read(): QueueFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as QueueFile;
      return Array.isArray(parsed?.items) ? parsed : { version: 1, items: [] };
    } catch { return { version: 1, items: [] }; }
  }

  private write(q: QueueFile) {
    const ended = q.items.filter((i) => !OPEN_STATES.includes(i.state));
    const drop = new Set(ended.sort((a, b) => (b.endedAt ?? b.enqueuedAt).localeCompare(a.endedAt ?? a.enqueuedAt)).slice(KEEP_ENDED).map((i) => i.id));
    const out: QueueFile = { version: 1, items: q.items.filter((i) => !drop.has(i.id)) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Read, change, write in one synchronous step; returns what fn returns. */
  private mutate<T>(fn: (q: QueueFile) => T): T {
    const q = this.read();
    const out = fn(q);
    this.write(q);
    return out;
  }

  private update(id: string, patch: Partial<RunQueueItem>) {
    this.mutate((q) => { const item = q.items.find((i) => i.id === id); if (item) Object.assign(item, patch); });
  }

  get(id: string): RunQueueItem | undefined { return this.read().items.find((i) => i.id === id); }

  /** The key's waiting or starting item, if any. */
  pending(key: string): RunQueueItem | undefined {
    return this.read().items.find((i) => i.key === key && OPEN_STATES.includes(i.state));
  }

  /** The key's newest ended item that is not `started` (failed, cancelled, skipped). */
  lastUnstarted(key: string): RunQueueItem | undefined {
    return this.read().items.filter((i) => i.key === key && ['failed', 'cancelled', 'skipped'].includes(i.state))
      .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0];
  }

  /** The start's detail (lease, worktree notes) for the request that enqueued `id`, once. */
  takeDetail(id: string): Record<string, unknown> | undefined {
    const d = this.details.get(id);
    this.details.delete(id);
    return d;
  }

  /** Queues a Run. One waiting item per task (or for the knowledge re-check): a second is refused. */
  enqueue(input: EnqueueInput): RunQueueItem {
    return this.mutate((q) => {
      const open = q.items.find((i) => i.key === input.key && OPEN_STATES.includes(i.state));
      if (open) throw new QueueRefusedError(`${open.label} is already queued (${open.id}, ${open.state}); cancel it first.`);
      const item: RunQueueItem = {
        id: `q-${this.now().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 6)}`,
        kind: input.kind, key: input.key, label: input.label, enqueuedAt: this.now().toISOString(), trigger: input.trigger, state: 'waiting',
        ...(input.step ? { step: input.step } : {}), ...(input.round ? { round: input.round } : {}),
      };
      if (input.trigger.kind === 'after') item.after = this.resolveAfter(q, input.trigger.taskId);
      q.items.push(item);
      return item;
    });
  }

  /** The step an after trigger waits on: the other task's queued item, else its step in flight, else its next step. */
  private resolveAfter(q: QueueFile, taskId: string): NonNullable<RunQueueItem['after']> {
    const queued = q.items.find((i) => i.key === taskId && OPEN_STATES.includes(i.state));
    if (queued) return { itemId: queued.id };
    const latest = this.deps.launches.latest(taskId);
    if (latest && (isRunning(latest) || this.deps.verifying(latest.id))) return { launchId: latest.id };
    return { since: this.now().toISOString() };
  }

  /** Cancels a waiting item; refused once it is starting or ended. */
  cancel(id: string): RunQueueItem {
    return this.mutate((q) => {
      const item = q.items.find((i) => i.id === id);
      if (!item) throw new QueueRefusedError('Queue item not found. Refresh first.', 404);
      if (item.state !== 'waiting') throw new QueueRefusedError(`${item.label} is ${item.state}: only a waiting item can be cancelled${item.state === 'started' ? ' (stop its launch instead)' : ''}.`);
      Object.assign(item, { state: 'cancelled', reason: 'cancelled by the operator before it started', endedAt: this.now().toISOString() });
      return item;
    });
  }

  /** Running launches plus items being started whose launch is not visible yet. */
  running(items = this.read().items): number {
    const active = this.deps.launches.active();
    const ids = new Set(active.map((l) => l.id));
    return active.length + items.filter((i) => i.state === 'starting' && !(i.launchId && ids.has(i.launchId))).length;
  }

  /**
   * Where an after trigger stands: fired (with how the step ended), waiting (with what),
   * or dead (the step it waits on will never run). May resolve the reference (since → launch, item → launch).
   */
  private afterState(item: RunQueueItem, items: RunQueueItem[]): { fired?: string; waiting?: string; dead?: string; after?: RunQueueItem['after'] } {
    const taskId = item.trigger.kind === 'after' ? item.trigger.taskId : item.key;
    let ref = item.after ?? { since: item.enqueuedAt };
    if (ref.itemId) {
      const other = items.find((i) => i.id === ref.itemId);
      if (!other) return { dead: `${taskId}'s queued step is no longer on record` };
      if (OPEN_STATES.includes(other.state)) return { waiting: `${taskId}'s queued step to run and end` };
      if (other.state !== 'started' || !other.launchId) return { dead: `${taskId}'s queued step did not run (${other.state}${other.reason ? `: ${other.reason}` : ''})` };
      ref = { launchId: other.launchId };
    }
    if (ref.since) {
      const latest = this.deps.launches.latest(taskId);
      if (!latest || latest.startedAt < ref.since) return { waiting: `${taskId}'s next step to start and end` };
      ref = { launchId: latest.id };
    }
    const launch = this.deps.launches.get(ref.launchId!);
    if (!launch) return { fired: `${taskId}'s step is no longer on record`, after: ref };
    if (isRunning(launch)) return { waiting: `${taskId}'s step (${launch.status})`, after: ref };
    if (this.deps.verifying(launch.id)) return { waiting: `${taskId}'s step to be verified`, after: ref };
    return { fired: `${taskId}'s step ${launch.status}`, after: ref };
  }

  /** Whether the item's trigger has fired, with the text; else what it waits for. */
  private triggerState(item: RunQueueItem, items: RunQueueItem[], now: Date) {
    const t = item.trigger;
    if (t.kind === 'now') return { fired: '' };
    if (t.kind === 'at') return Date.parse(t.at) <= now.getTime() ? { fired: '' } : { waiting: `its time (${t.at})` };
    return this.afterState(item, items);
  }

  private waitingFor(item: RunQueueItem, items: RunQueueItem[], now: Date, running: number): string {
    if (item.state === 'starting') return 'the dashboard to start it';
    const trig = this.triggerState(item, items, now);
    if (trig.waiting) return trig.waiting;
    if (trig.dead) return `nothing: ${trig.dead}`;
    const busy = this.deps.busy(item.key);
    if (busy) return `its task to be free: ${busy}`;
    if (running >= this.deps.cap) return `a free slot (${running} of ${this.deps.cap} running)`;
    return 'the next tick';
  }

  view(): RunQueueView {
    const items = this.read().items;
    const now = this.now();
    const running = this.running(items);
    const open = items.filter((i) => OPEN_STATES.includes(i.state)).sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
    return {
      cap: this.deps.cap, running,
      items: open.map((i) => ({ ...i, waitingFor: this.waitingFor(i, items, now, running) })),
      recent: items.filter((i) => !OPEN_STATES.includes(i.state)).sort((a, b) => (b.endedAt ?? b.startedAt ?? '').localeCompare(a.endedAt ?? a.startedAt ?? '')).slice(0, RECENT),
    };
  }

  /** The item with what it waits for now (for a response right after enqueue). */
  itemView(id: string): RunQueueItem | undefined {
    return this.view().items.find((i) => i.id === id) ?? this.get(id);
  }

  /** Advance once (serialized: overlapping calls run one after another). */
  tick(): Promise<void> {
    const run = this.chain.then(() => this.doTick());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Ticks every intervalMs (unref'd: never keeps the process alive). */
  startTimer(intervalMs: number, before?: () => Promise<void>) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      (before ? before() : Promise.resolve()).then(() => this.tick()).catch((err) => console.warn('run queue tick failed:', err));
    }, intervalMs);
    this.timer.unref();
  }

  private async doTick(): Promise<void> {
    const now = this.now();
    const stamp = now.toISOString();
    this.mutate((q) => {
      for (const item of q.items) {
        if (item.state === 'starting' && !this.startingNow.has(item.id)) {
          const launch = item.launchId ? this.deps.launches.get(item.launchId) : null;
          if (launch) Object.assign(item, { state: 'started', startedAt: launch.startedAt });
          else Object.assign(item, { state: 'failed', reason: 'interrupted: the dashboard stopped while starting it; queue it again', endedAt: stamp });
          continue;
        }
        if (item.state !== 'waiting') continue;
        if (item.trigger.kind === 'at' && Date.parse(item.trigger.at) <= now.getTime() && !item.dueSince) {
          if (now.getTime() - Date.parse(item.trigger.at) > AT_MISSED_GRACE_MS) {
            Object.assign(item, { state: 'failed', reason: `missed: it was due at ${item.trigger.at} and the dashboard was not running then (first checked ${stamp})`, endedAt: stamp });
            continue;
          }
          item.dueSince = stamp;
        }
        if (item.trigger.kind === 'after') {
          const s = this.afterState(item, q.items);
          if (s.after) item.after = s.after;
          if (s.dead) Object.assign(item, { state: 'failed', reason: `its trigger cannot fire: ${s.dead}`, endedAt: stamp });
        }
      }
    });

    for (;;) {
      const next = this.mutate((q) => {
        if (this.running(q.items) >= this.deps.cap) return null;
        const startingKeys = new Set(q.items.filter((i) => i.state === 'starting').map((i) => i.key));
        const ready = q.items.filter((i) => i.state === 'waiting').sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt))
          .find((i) => !startingKeys.has(i.key) && this.triggerState(i, q.items, now).fired !== undefined && !this.deps.busy(i.key));
        if (!ready) return null;
        const trig = this.triggerState(ready, q.items, now);
        const late = ready.trigger.kind === 'at' ? Math.round((now.getTime() - Date.parse(ready.trigger.at)) / 60_000) : 0;
        Object.assign(ready, { state: 'starting', launchId: this.newLaunchId(),
          ...(trig.fired ? { fired: trig.fired } : late >= 1 ? { fired: `${late} min after its time` } : {}) });
        this.startingNow.add(ready.id);
        return { ...ready };
      });
      if (!next) return;
      try {
        const outcome = await this.deps.start(next);
        if (!outcome) this.update(next.id, { state: 'skipped', reason: 'nothing to do when it came up', endedAt: this.now().toISOString(), launchId: undefined });
        else {
          this.update(next.id, { state: 'started', launchId: outcome.launch.id, startedAt: outcome.launch.startedAt });
          if (outcome.detail) this.details.set(next.id, outcome.detail);
        }
      } catch (err) {
        this.update(next.id, { state: 'failed', reason: err instanceof Error ? err.message : String(err), endedAt: this.now().toISOString(), launchId: undefined });
      } finally {
        this.startingNow.delete(next.id);
      }
    }
  }
}
