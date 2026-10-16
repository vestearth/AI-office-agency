import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import yaml from 'js-yaml';
import path from 'path';
import { OPEN_PROMPT_CAP, OPEN_TARGET_LABELS } from '../../../shared/openHandoff';
import type { OpenHandoff, OpenTarget } from '../../../shared/types';
import { TASK_ID_PATTERN } from '../pathSecurity';

// Start or open task › Open (docs/start-task-redesign-spec.md, D8/D15): hand a task step
// to an app the operator drives, on the task's worktree, with the step's prompt
// prefilled and not sent. The server opens the documented deep link with
// /usr/bin/open through execFile (no shell, no Automation permission); cursor is prompt
// only. An Open takes no lease, so each one is recorded in runs/<TASK>/open-handoffs.yaml
// (dashboard-owned like decision.yaml, local: runs/ ignores it) for a later Run to warn.

export const OPEN_TARGETS = ['claude-desktop', 'claude-cli', 'codex-app', 'cursor'] as const satisfies readonly OpenTarget[];

/** Opens a URL with the OS; injected so tests never launch an app. */
export type Opener = (url: string) => Promise<void>;

export const macOpener: Opener = (url) => new Promise((resolve, reject) => {
  execFile('/usr/bin/open', [url], { timeout: 15_000 }, (err, _stdout, stderr) => {
    if (err) reject(new Error(`open failed: ${String(stderr || err.message).trim()}`));
    else resolve();
  });
});

const enc = encodeURIComponent;

/** The documented prefill deep link for a target (R2), every parameter percent-encoded; null for cursor. */
export function openUrl(target: OpenTarget, prompt: string, folder: string): string | null {
  switch (target) {
    case 'claude-desktop': return `claude://code/new?q=${enc(prompt)}&folder=${enc(folder)}`;
    case 'claude-cli': return `claude-cli://open?cwd=${enc(folder)}&q=${enc(prompt)}`;
    case 'codex-app': return `codex://new?prompt=${enc(prompt)}&path=${enc(folder)}`;
    default: return null;
  }
}

/** The deep links need /usr/bin/open: macOS only (D9). */
export function openAvailability(platform: NodeJS.Platform): { available: boolean; reason?: string } {
  return platform === 'darwin' ? { available: true } : { available: false, reason: 'Open is macOS only for now: it opens the apps\' deep links with /usr/bin/open' };
}

/** Why the prompt cannot be prefilled, or null. Refused rather than cut: the end of the prompt is the output contract. */
export function promptCapError(prompt: string): string | null {
  return prompt.length > OPEN_PROMPT_CAP
    ? `The prompt is ${prompt.length.toLocaleString('en-US')} characters, over the ${OPEN_PROMPT_CAP.toLocaleString('en-US')} an app link takes: shorten the additional instructions, or use Copy prompt and paste it yourself.`
    : null;
}

/**
 * Why `target` cannot be opened with this prompt here, or null; checked before any
 * worktree is made. Cursor gets no link (its prompt is copied), so neither the platform
 * nor the cap applies to it.
 */
export function openRefusal(target: OpenTarget, prompt: string, platform: NodeJS.Platform): { status: number; message: string } | null {
  if (target === 'cursor') return null;
  const gate = openAvailability(platform);
  if (!gate.available) return { status: 400, message: `${gate.reason}.` };
  const capError = promptCapError(prompt);
  return capError ? { status: 413, message: capError } : null;
}

const HANDOFFS_KEPT = 20;
type HandoffYaml = { id: string; at: string; target: OpenTarget; role: string; worktree: string; repos: string[]; prompt_sha256: string };

const fromYaml = (h: Partial<HandoffYaml>): OpenHandoff | null => (typeof h?.at === 'string' && typeof h.target === 'string' && h.target in OPEN_TARGET_LABELS
  ? { id: String(h.id ?? ''), at: h.at, target: h.target, role: String(h.role ?? ''), worktree: String(h.worktree ?? ''), repos: Array.isArray(h.repos) ? h.repos.map(String) : [], promptSha256: String(h.prompt_sha256 ?? '') }
  : null);

/** runs/<TASK>/open-handoffs.yaml: `task_id` and `handoffs` (oldest first, the last 20), written atomically, one writer per task at a time. */
export class HandoffStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private counter = 0;

  constructor(private readonly runsDir: string) {}

  private file(taskId: string): string {
    if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`Invalid taskId: ${taskId}`);
    return path.join(this.runsDir, taskId, 'open-handoffs.yaml');
  }

  async read(taskId: string): Promise<OpenHandoff[]> {
    try {
      const doc = yaml.load(await fs.readFile(this.file(taskId), 'utf8')) as { handoffs?: unknown } | null;
      return (Array.isArray(doc?.handoffs) ? doc.handoffs : []).map(fromYaml).filter((h): h is OpenHandoff => h !== null);
    } catch { return []; }
  }

  async latest(taskId: string): Promise<OpenHandoff | undefined> {
    return (await this.read(taskId)).at(-1);
  }

  append(taskId: string, handoff: OpenHandoff): Promise<OpenHandoff> {
    const next = (this.queues.get(taskId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const kept = [...await this.read(taskId), handoff].slice(-HANDOFFS_KEPT);
      const doc = { task_id: taskId, handoffs: kept.map((h) => ({ id: h.id, at: h.at, target: h.target, role: h.role, worktree: h.worktree, repos: h.repos, prompt_sha256: h.promptSha256 })) };
      const target = this.file(taskId);
      const tmp = `${target}.tmp.${process.pid}.${this.counter++}`;
      await fs.writeFile(tmp, yaml.dump(doc), 'utf8');
      await fs.rename(tmp, target);
      return handoff;
    });
    this.queues.set(taskId, next);
    next.catch(() => undefined).finally(() => { if (this.queues.get(taskId) === next) this.queues.delete(taskId); });
    return next;
  }
}

export interface OpenDeps { platform: NodeJS.Platform; opener: Opener; store: HandoffStore; now?: () => Date }

/**
 * Opens the step in `target` on the primary worktree and records the hand-off; throws
 * with a status and the reason when it cannot (platform, cap, open failed). Nothing is
 * recorded when the open fails.
 */
export async function openStep(deps: OpenDeps, input: { taskId: string; target: OpenTarget; role: string; prompt: string; worktrees: { repo: string; path: string }[] }): Promise<{ handoff: OpenHandoff; url?: string }> {
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
  const [primary] = input.worktrees;
  if (!primary) throw fail(400, 'Confirm at least one target repository: Open works on a task worktree.');
  const refused = openRefusal(input.target, input.prompt, deps.platform);
  if (refused) throw fail(refused.status, refused.message);
  const url = openUrl(input.target, input.prompt, primary.path);
  if (url) {
    try { await deps.opener(url); } catch (err) { throw fail(502, err instanceof Error ? err.message : 'open failed'); }
  }
  const handoff: OpenHandoff = {
    id: randomUUID().slice(0, 8), at: (deps.now?.() ?? new Date()).toISOString(), target: input.target, role: input.role,
    worktree: primary.path, repos: input.worktrees.map((w) => w.repo), promptSha256: createHash('sha256').update(input.prompt).digest('hex'),
  };
  await deps.store.append(input.taskId, handoff);
  return { handoff, ...(url ? { url } : {}) };
}
