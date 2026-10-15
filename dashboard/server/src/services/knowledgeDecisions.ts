import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import type {
  KnowledgeDecisionAnswer, KnowledgeDecisionKind, KnowledgeHumanDecision, KnowledgeOpenFinding,
} from '@shared/types';
import { ACTOR_MAX_LEN, NOTE_MAX_LEN } from './decisionStore';
import { asObject } from './runScanner';

// Knowledge › Decisions: the operator's answers to human-decision findings.
// The ledger is an INPUT to the next Librarian re-check, never finding state:
// a finding closes only when an audit records it (closure spec D4, amended
// 2026-10-15). Same write discipline as decision.yaml (decisionStore.ts):
// serialized appends, fsync before rename. It lives in a subfolder because the
// review loader reads every *.yaml directly under knowledge-reviews/ as an audit.

export const DECISION_ANSWERS: readonly KnowledgeDecisionAnswer[] = [
  'existing_proposal_enough', 'still_true', 'no_longer_true', 'check_it', 'approve', 'reject', 'answer', 'defer',
];
const NOTE_REQUIRED: readonly KnowledgeDecisionAnswer[] = ['answer', 'no_longer_true'];
const FINGERPRINT_MAX_LEN = 300;

export function isDecisionAnswer(v: unknown): v is KnowledgeDecisionAnswer {
  return typeof v === 'string' && (DECISION_ANSWERS as readonly string[]).includes(v);
}

/**
 * What kind of answer a question asks for — a hint that picks the default buttons;
 * every kind can still be answered in words or deferred. Checked in this order.
 */
export function classifyDecisionKind(question: string): KnowledgeDecisionKind {
  const q = question.trim();
  // The Librarian asking whether to repeat a proposal it already made.
  if (/(second|another|duplicat\w*|beyond the existing|alter the existing)[^?]*\b(proposal|correction)\b/i.test(q)
    || /existing proposal[^?]*duplicat/i.test(q)) return 'duplicate_proposal';
  if (/^(should|is)\b/i.test(q) && /\b(promot\w*|safe to retain|remain discoverable|be captured|accepted|amendment)\b/i.test(q)) return 'approval';
  if (/^(is|are|has|have|does|do|was)\b/i.test(q) && /\b(still|current|currently|verified|accurate|accurately|received|implemented|clean working tree)\b/i.test(q)) return 'status_check';
  return 'product';
}

export type DecisionInput = { fingerprint: string; answer: KnowledgeDecisionAnswer; note?: string; actor: string };

export function validateDecision(body: unknown): { ok: true; value: DecisionInput } | { ok: false; error: string } {
  const b = asObject(body);
  if (typeof b.fingerprint !== 'string' || !b.fingerprint.trim() || b.fingerprint.length > FINGERPRINT_MAX_LEN) {
    return { ok: false, error: 'fingerprint is required' };
  }
  if (!isDecisionAnswer(b.answer)) return { ok: false, error: `answer must be one of ${DECISION_ANSWERS.join('|')}` };
  if (typeof b.actor !== 'string' || !b.actor.trim()) return { ok: false, error: 'actor is required (who is answering)' };
  if (b.actor.length > ACTOR_MAX_LEN) return { ok: false, error: `actor exceeds ${ACTOR_MAX_LEN} characters` };
  if (b.note !== undefined && typeof b.note !== 'string') return { ok: false, error: 'note must be a string' };
  if (typeof b.note === 'string' && b.note.length > NOTE_MAX_LEN) return { ok: false, error: `note exceeds ${NOTE_MAX_LEN} characters` };
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : undefined;
  if (NOTE_REQUIRED.includes(b.answer) && !note) return { ok: false, error: `a note is required for "${b.answer}"` };
  return { ok: true, value: { fingerprint: b.fingerprint.trim(), answer: b.answer, note, actor: b.actor.trim() } };
}

function toDecision(raw: unknown): KnowledgeHumanDecision | null {
  const r = asObject(raw);
  if (typeof r.id !== 'string' || typeof r.fingerprint !== 'string' || !isDecisionAnswer(r.answer)
    || typeof r.actor !== 'string' || typeof r.decided_at !== 'string') return null;
  return {
    id: r.id, fingerprint: r.fingerprint, answer: r.answer, actor: r.actor, decidedAt: r.decided_at,
    note: typeof r.note === 'string' ? r.note : undefined,
    question: typeof r.question === 'string' ? r.question : '',
    notePath: typeof r.note_path === 'string' ? r.note_path : '',
  };
}

function toEntry(d: KnowledgeHumanDecision): Record<string, unknown> {
  return {
    id: d.id, fingerprint: d.fingerprint, answer: d.answer, ...(d.note ? { note: d.note } : {}),
    actor: d.actor, decided_at: d.decidedAt, question: d.question, note_path: d.notePath,
  };
}

/** Latest answer per fingerprint (the ledger is append-only; a new answer replaces the old one). */
export function latestDecisions(all: KnowledgeHumanDecision[]): Map<string, KnowledgeHumanDecision> {
  const latest = new Map<string, KnowledgeHumanDecision>();
  for (const d of all) latest.set(d.fingerprint, d);
  return latest;
}

/** Adds kind, the latest answer and whether it still waits for a re-check run. */
export function attachDecisions(items: KnowledgeOpenFinding[], latest: Map<string, KnowledgeHumanDecision>): KnowledgeOpenFinding[] {
  return items.map((f) => {
    const decision = latest.get(f.fingerprint);
    return {
      ...f,
      ...(f.needsHumanDecision ? { decisionKind: classifyDecisionKind(f.question) } : {}),
      ...(decision ? {
        humanDecision: decision,
        decisionPending: decision.answer !== 'defer' && decision.decidedAt > f.lastReportedAt,
      } : {}),
    };
  });
}

export class HumanDecisionStore {
  private queue: Promise<unknown> = Promise.resolve();
  private tmpCounter = 0;

  constructor(private readonly reviewsDir: string) {}

  get file(): string {
    return path.join(this.reviewsDir, 'decisions', 'human-decisions.yaml');
  }

  async read(): Promise<KnowledgeHumanDecision[]> {
    try {
      const data = asObject(yaml.load(await fs.readFile(this.file, 'utf8')));
      return (Array.isArray(data.decisions) ? data.decisions : []).map(toDecision).filter((d): d is KnowledgeHumanDecision => d !== null);
    } catch {
      return [];
    }
  }

  append(input: DecisionInput & { question: string; notePath: string }, now = new Date()): Promise<KnowledgeHumanDecision> {
    const next = this.queue.catch(() => undefined).then(() => this.appendUnsafe(input, now));
    this.queue = next;
    return next;
  }

  private async appendUnsafe(input: DecisionInput & { question: string; notePath: string }, now: Date): Promise<KnowledgeHumanDecision> {
    const existing = await this.read();
    const seq = existing.reduce((max, d) => Math.max(max, Number(d.id.replace(/^hd-/, '')) || 0), 0) + 1;
    const decision: KnowledgeHumanDecision = {
      id: `hd-${String(seq).padStart(3, '0')}`, fingerprint: input.fingerprint, answer: input.answer,
      ...(input.note ? { note: input.note } : {}), actor: input.actor, decidedAt: now.toISOString(),
      question: input.question, notePath: input.notePath,
    };
    const doc = {
      // Read by the weekly re-check run through the task brief; see workflows/knowledge-librarian.md.
      purpose: 'Operator answers to human-decision knowledge findings (input to the Librarian re-check, not finding state)',
      decisions: [...existing, decision].map(toEntry),
    };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}.${this.tmpCounter++}`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(yaml.dump(doc, { lineWidth: 120 }), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.file);
    return decision;
  }
}
