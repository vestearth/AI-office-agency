import fs from 'fs';
import path from 'path';
import type { KnowledgeChainView, OfficeLaunch, RunQueueItem } from '../../../shared/types';
import type { RunQueue } from './runQueue';

// Knowledge › Run re-check now ×N: rounds run one after another. Each round is an
// ordinary knowledge launch that goes through the Run queue (runQueue.ts, D10/D13), so it
// counts against the global cap like a task step: it starts when a slot is free. The
// next round is queued only after the previous one succeeded, and its brief is built
// when it starts, so it picks the notes the last audit did not look at. The chain lives
// in a file beside the launches and advances with the queue's timer, so it keeps going
// across a dashboard restart. It ends on a failed, lost or stopped round, a round that
// could not start or was cancelled in the queue, Stop, or when there is nothing left to
// re-check.

export const CHAIN_ROUNDS = [1, 3, 5] as const;
const KEY = 'knowledge';
const LABEL = 'Knowledge re-check';

interface ChainState {
  total: number;
  /** Rounds started so far. */
  started: number;
  lastLaunchId?: string;
  /** The next round's queue item while it waits to start. */
  itemId?: string;
  startedAt: string;
  ended?: { at: string; reason: string };
}

export interface ChainLaunches {
  latest(key: string): OfficeLaunch | null;
  stop(id: string): OfficeLaunch;
}

const running = (l: OfficeLaunch | null) => Boolean(l && ['running', 'stopping'].includes(l.status));

export class KnowledgeChain {
  constructor(
    private readonly launcher: ChainLaunches,
    private readonly queue: RunQueue,
    private readonly file: string,
    private readonly now = () => new Date(),
  ) {}

  private read(): ChainState | null {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as ChainState; } catch { return null; }
  }

  private write(state: ChainState) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  view(): KnowledgeChainView | null {
    const s = this.read();
    if (!s) return null;
    const queued = s.itemId && !s.ended ? this.queue.itemView(s.itemId) : undefined;
    return {
      total: s.total, round: s.started, startedAt: s.startedAt, ...(s.ended ? { ended: s.ended } : {}),
      ...(queued && ['waiting', 'starting'].includes(queued.state) ? { queued: { itemId: queued.id, waitingFor: queued.waitingFor ?? 'its turn' } } : {}),
    };
  }

  private enqueueRound(number: number, total: number): RunQueueItem {
    return this.queue.enqueue({ kind: 'knowledge', key: KEY, label: total > 1 ? `${LABEL} round ${number} of ${total}` : LABEL, trigger: { kind: 'now' }, round: { number, total } });
  }

  /**
   * Queues round 1 and starts it when a slot is free. Throws when a round is running or
   * queued, or round 1 could not start; launch null with a chain: queued behind the cap;
   * launch and chain null: nothing to re-check.
   */
  async start(rounds: number): Promise<{ launch: OfficeLaunch | null; chain: KnowledgeChainView | null; queued?: RunQueueItem }> {
    if (!(CHAIN_ROUNDS as readonly number[]).includes(rounds)) throw new Error(`Rounds must be one of ${CHAIN_ROUNDS.join(', ')}.`);
    const current = this.launcher.latest(KEY);
    if (running(current)) throw new Error(`A knowledge re-check is already running (started ${current!.startedAt}).`);
    const item = this.enqueueRound(1, rounds);
    await this.queue.tick();
    const after = this.queue.get(item.id);
    const startedAt = this.now().toISOString();
    if (after?.state === 'skipped') return { launch: null, chain: null };
    if (after?.state === 'failed' || after?.state === 'cancelled' || !after) throw new Error(after?.reason ?? 'The knowledge re-check could not be queued.');
    if (after.state === 'started') {
      this.write({ total: rounds, started: 1, lastLaunchId: after.launchId, startedAt });
      return { launch: this.launcher.latest(KEY), chain: this.view() };
    }
    this.write({ total: rounds, started: 0, itemId: item.id, startedAt });
    return { launch: null, chain: this.view(), queued: this.queue.itemView(item.id) };
  }

  /** Advance once: follow a queued round, queue the next round when the last one succeeded, or record why the chain ended. */
  async tick(): Promise<void> {
    const s = this.read();
    if (!s || s.ended) return;
    if (s.itemId) {
      const item = this.queue.get(s.itemId);
      const round = s.started + 1;
      if (!item) return this.end(s, `round ${round}'s queue item is no longer on record`);
      if (item.state === 'waiting' || item.state === 'starting') return;
      if (item.state === 'skipped') return this.end(s, `nothing left to re-check after round ${s.started}`);
      if (item.state === 'failed') return this.end(s, `round ${round} could not start: ${item.reason ?? 'unknown reason'}`);
      if (item.state === 'cancelled') return this.end(s, `round ${round} was cancelled in the queue before it started`);
      this.write({ ...s, started: round, lastLaunchId: item.launchId, itemId: undefined });
      return;
    }
    const last = this.launcher.latest(KEY);
    if (!last || last.id !== s.lastLaunchId) return this.end(s, 'the last round is no longer on record');
    if (running(last)) return;
    if (last.status !== 'succeeded') return this.end(s, `round ${s.started} ${last.status}`);
    if (s.started >= s.total) return this.end(s, `all ${s.total} rounds finished`);
    let item: RunQueueItem;
    try { item = this.enqueueRound(s.started + 1, s.total); } catch (err) { return this.end(s, `round ${s.started + 1} could not be queued: ${err instanceof Error ? err.message : String(err)}`); }
    this.write({ ...s, itemId: item.id });
    await this.queue.tick();
    return this.tick();
  }

  /** Ends the chain, cancels its queued round and stops its running round. */
  stop(): OfficeLaunch | null {
    const s = this.read();
    if (s && !s.ended) {
      if (s.itemId) { try { this.queue.cancel(s.itemId); } catch { /* already starting or ended */ } }
      this.end(s, `stopped by the operator in round ${s.itemId ? s.started + 1 : s.started}`);
    }
    const current = this.launcher.latest(KEY);
    return current && running(current) ? this.launcher.stop(current.id) : current;
  }

  private end(s: ChainState, reason: string) {
    this.write({ ...s, ended: { at: this.now().toISOString(), reason } });
  }
}
