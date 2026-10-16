import fs from 'fs';
import path from 'path';
import type { KnowledgeChainView, OfficeLaunch } from '../../../shared/types';
import type { OfficeLauncher } from './officeLauncher';

// Knowledge › Run re-check now ×N: rounds run one after another. Each round is an
// ordinary knowledge launch; the next starts only after the previous one succeeded,
// with a brief rebuilt then, so it picks the notes the last audit did not look at.
// The chain lives in a file beside the launches and advances on a timer, so it
// keeps going across a dashboard restart. It ends on a failed, lost or stopped
// round, on Stop, or when there is nothing left to re-check.

export const CHAIN_ROUNDS = [1, 3, 5] as const;
const KEY = 'knowledge';

interface ChainState {
  total: number;
  /** Rounds started so far. */
  started: number;
  lastLaunchId: string;
  startedAt: string;
  ended?: { at: string; reason: string };
}

/** Starts one round; null when there is nothing to re-check. Throws when it cannot start. */
export type StartRound = () => Promise<OfficeLaunch | null>;

export class KnowledgeChain {
  constructor(
    private readonly launcher: OfficeLauncher,
    private readonly startRound: StartRound,
    private readonly file: string,
    private readonly now = () => new Date(),
  ) {}

  private read(): ChainState | null {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) as ChainState; } catch { return null; }
  }

  private write(state: ChainState) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(state, null, 2));
  }

  view(): KnowledgeChainView | null {
    const s = this.read();
    return s ? { total: s.total, round: s.started, startedAt: s.startedAt, ...(s.ended ? { ended: s.ended } : {}) } : null;
  }

  /** Throws when a round is already running or the first round cannot start. */
  async start(rounds: number): Promise<{ launch: OfficeLaunch | null; chain: KnowledgeChainView | null }> {
    if (!(CHAIN_ROUNDS as readonly number[]).includes(rounds)) throw new Error(`Rounds must be one of ${CHAIN_ROUNDS.join(', ')}.`);
    const current = this.launcher.latest(KEY);
    if (current && ['running', 'stopping'].includes(current.status)) throw new Error(`A knowledge re-check is already running (started ${current.startedAt}).`);
    const launch = await this.startRound();
    if (!launch) return { launch: null, chain: null };
    this.write({ total: rounds, started: 1, lastLaunchId: launch.id, startedAt: this.now().toISOString() });
    return { launch, chain: this.view() };
  }

  /** Advance once: start the next round when the last one succeeded, or record why the chain ended. */
  async tick(): Promise<void> {
    const s = this.read();
    if (!s || s.ended) return;
    const last = this.launcher.latest(KEY);
    if (!last || last.id !== s.lastLaunchId) return this.end(s, 'the last round is no longer on record');
    if (['running', 'stopping'].includes(last.status)) return;
    if (last.status !== 'succeeded') return this.end(s, `round ${s.started} ${last.status}`);
    if (s.started >= s.total) return this.end(s, `all ${s.total} rounds finished`);
    let next: OfficeLaunch | null;
    try { next = await this.startRound(); } catch (err) { return this.end(s, `round ${s.started + 1} could not start: ${err instanceof Error ? err.message : String(err)}`); }
    if (!next) return this.end(s, `nothing left to re-check after round ${s.started}`);
    this.write({ ...s, started: s.started + 1, lastLaunchId: next.id });
  }

  /** Ends the chain and stops its running round. */
  stop(): OfficeLaunch | null {
    const s = this.read();
    if (s && !s.ended) this.end(s, `stopped by the operator in round ${s.started}`);
    const current = this.launcher.latest(KEY);
    return current && ['running', 'stopping'].includes(current.status) ? this.launcher.stop(current.id) : current;
  }

  private end(s: ChainState, reason: string) {
    this.write({ ...s, ended: { at: this.now().toISOString(), reason } });
  }
}
