import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { handoffWarning, HANDOFF_WARN_DAYS, OPEN_PROMPT_CAP } from '../../../shared/openHandoff';
import type { OpenHandoff } from '../../../shared/types';
import { HandoffStore, openAvailability, openRefusal, openStep, openUrl, type Opener } from './openHandoff';

// Start or open task › Open (spec D8/D15): the deep link per target, its encoding, the
// 5,000-character cap, the macOS gate, the hand-off record and the Run warning it feeds.
// The opener is injected: no test launches an app.

const TASK = 'TASK-T-7';
const FOLDER = '/ws/.worktrees/api gateway-TASK-T-7';
const PROMPT = 'Line one & two = 3?\nLine #2: 100% +plus ไทย "quoted" /slash';

function tmpRuns() {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'open-handoffs-'));
  fs.mkdirSync(path.join(runs, TASK));
  return { runs, cleanup: () => fs.rmSync(runs, { recursive: true, force: true }) };
}

function recordingOpener(fail?: string): Opener & { urls: string[] } {
  const urls: string[] = [];
  return Object.assign(async (url: string) => { urls.push(url); if (fail) throw new Error(fail); }, { urls });
}

test('each deep link has its documented shape, and every parameter round-trips through percent-encoding', () => {
  const cases = [
    { target: 'claude-desktop', prefix: 'claude://code/new?q=', prompt: 'q', folder: 'folder' },
    { target: 'claude-cli', prefix: 'claude-cli://open?cwd=', prompt: 'q', folder: 'cwd' },
    { target: 'codex-app', prefix: 'codex://new?prompt=', prompt: 'prompt', folder: 'path' },
  ] as const;
  for (const c of cases) {
    const url = openUrl(c.target, PROMPT, FOLDER)!;
    assert.ok(url.startsWith(c.prefix), url);
    const query = url.slice(url.indexOf('?') + 1);
    assert.deepEqual(query.split('&').map((kv) => kv.split('=')[0]), c.target === 'claude-cli' ? ['cwd', 'q'] : [c.prompt, c.folder], 'two parameters, nothing leaks a separator');
    assert.doesNotMatch(query, /[ \n#"+]/, 'spaces, newlines, #, quotes and + are all encoded');
    const params = new URLSearchParams(query);
    assert.equal(params.get(c.prompt), PROMPT);
    assert.equal(params.get(c.folder), FOLDER);
  }
  assert.equal(openUrl('claude-cli', 'a b&c', '/w x'), 'claude-cli://open?cwd=%2Fw%20x&q=a%20b%26c');
  assert.equal(openUrl('cursor', PROMPT, FOLDER), null, 'Cursor is prompt only: its deeplink cannot set a folder');
});

test('the deep links are macOS only; cursor is not gated', () => {
  assert.deepEqual(openAvailability('darwin'), { available: true });
  for (const platform of ['win32', 'linux'] as const) {
    assert.match(openAvailability(platform).reason ?? '', /macOS only/);
    assert.equal(openRefusal('claude-desktop', 'p', platform)?.status, 400);
    assert.equal(openRefusal('cursor', 'p', platform), null);
  }
});

test('a prompt over 5,000 characters is refused with the count, never cut; exactly 5,000 opens', () => {
  assert.equal(openRefusal('codex-app', 'x'.repeat(OPEN_PROMPT_CAP), 'darwin'), null);
  const refused = openRefusal('codex-app', 'x'.repeat(OPEN_PROMPT_CAP + 1), 'darwin');
  assert.equal(refused?.status, 413);
  assert.match(refused?.message ?? '', /5,001 characters, over the 5,000.*Copy prompt/);
  assert.equal(openRefusal('cursor', 'x'.repeat(OPEN_PROMPT_CAP * 3), 'darwin'), null, 'a copied prompt has no link limit');
});

test('openStep opens the link once on the primary worktree and records the hand-off in runs/<TASK>/open-handoffs.yaml', async () => {
  const { runs, cleanup } = tmpRuns();
  try {
    const store = new HandoffStore(runs);
    const opener = recordingOpener();
    const now = () => new Date('2026-10-17T03:00:00Z');
    const worktrees = [{ repo: 'api-gateway', path: FOLDER }, { repo: 'shared-lib', path: '/ws/.worktrees/shared-lib-TASK-T-7' }];
    const { handoff, url } = await openStep({ platform: 'darwin', opener, store, now }, { taskId: TASK, target: 'claude-cli', role: 'dev', prompt: PROMPT, worktrees });
    assert.deepEqual(opener.urls, [openUrl('claude-cli', PROMPT, FOLDER)]);
    assert.equal(url, opener.urls[0]);
    assert.equal(handoff.at, '2026-10-17T03:00:00.000Z');
    assert.equal(handoff.worktree, FOLDER);
    assert.deepEqual(handoff.repos, ['api-gateway', 'shared-lib']);
    assert.match(handoff.promptSha256, /^[0-9a-f]{64}$/);
    const doc = yaml.load(fs.readFileSync(path.join(runs, TASK, 'open-handoffs.yaml'), 'utf8')) as { task_id: string; handoffs: Record<string, unknown>[] };
    assert.equal(doc.task_id, TASK);
    assert.deepEqual(Object.keys(doc.handoffs[0]), ['id', 'at', 'target', 'role', 'worktree', 'repos', 'prompt_sha256']);
    assert.equal(doc.handoffs[0].target, 'claude-cli');
    assert.deepEqual(await store.latest(TASK), handoff);
    assert.ok(!fs.readdirSync(path.join(runs, TASK)).some((f) => f.includes('.tmp.')), 'no temp file left');
    assert.ok(!fs.existsSync(path.join(runs, TASK, 'status.yaml')), 'Open never writes status.yaml');
  } finally { cleanup(); }
});

test('a refused or failed open records nothing; cursor records without opening anything', async () => {
  const { runs, cleanup } = tmpRuns();
  try {
    const store = new HandoffStore(runs);
    const worktrees = [{ repo: 'demo', path: FOLDER }];
    const failing = recordingOpener('LSOpenURLsWithRole() failed');
    await assert.rejects(openStep({ platform: 'darwin', opener: failing, store }, { taskId: TASK, target: 'codex-app', role: 'dev', prompt: 'p', worktrees }), (e: Error & { status?: number }) => e.status === 502 && /LSOpen/.test(e.message));
    const unused = recordingOpener();
    await assert.rejects(openStep({ platform: 'win32', opener: unused, store }, { taskId: TASK, target: 'claude-desktop', role: 'dev', prompt: 'p', worktrees }), /macOS only/);
    await assert.rejects(openStep({ platform: 'darwin', opener: unused, store }, { taskId: TASK, target: 'claude-desktop', role: 'dev', prompt: 'x'.repeat(5001), worktrees }), /over the 5,000/);
    await assert.rejects(openStep({ platform: 'darwin', opener: unused, store }, { taskId: TASK, target: 'claude-desktop', role: 'dev', prompt: 'p', worktrees: [] }), /at least one target repository/);
    assert.equal(unused.urls.length, 0);
    assert.deepEqual(await store.read(TASK), []);
    const { handoff, url } = await openStep({ platform: 'win32', opener: unused, store }, { taskId: TASK, target: 'cursor', role: 'reviewer', prompt: 'p', worktrees });
    assert.equal(url, undefined);
    assert.equal(unused.urls.length, 0);
    assert.equal((await store.latest(TASK))?.id, handoff.id);
  } finally { cleanup(); }
});

test('concurrent hand-offs are all kept, the newest 20 at most, and a bad task id never reaches the filesystem', async () => {
  const { runs, cleanup } = tmpRuns();
  try {
    const store = new HandoffStore(runs);
    const h = (i: number): OpenHandoff => ({ id: `h${i}`, at: new Date(Date.UTC(2026, 9, 17, 0, i)).toISOString(), target: 'codex-app', role: 'dev', worktree: FOLDER, repos: ['demo'], promptSha256: 'x' });
    await Promise.all(Array.from({ length: 5 }, (_, i) => store.append(TASK, h(i))));
    assert.deepEqual((await store.read(TASK)).map((x) => x.id), ['h0', 'h1', 'h2', 'h3', 'h4']);
    for (let i = 5; i < 25; i += 1) await store.append(TASK, h(i));
    const kept = await store.read(TASK);
    assert.equal(kept.length, 20);
    assert.equal(kept[0].id, 'h5');
    await assert.rejects(store.append('../etc', h(0)), /Invalid taskId/);
  } finally { cleanup(); }
});

test('the Run warning: a hand-off after the last step (or with none) and within 7 days warns; older, earlier or while running does not', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const handoff: OpenHandoff = { id: 'a', at: '2026-10-17T11:00:00Z', target: 'claude-desktop', role: 'dev', worktree: FOLDER, repos: ['demo'], promptSha256: 'x' };
  const step = (finishedAt: string, status = 'succeeded') => ({ status, startedAt: '2026-10-17T09:00:00Z', finishedAt });
  assert.match(handoffWarning(handoff, null, now) ?? '', /^dev was opened in Claude desktop 1h ago \(.*api gateway-TASK-T-7\): .*holds no lease/);
  assert.match(handoffWarning(handoff, step('2026-10-17T10:00:00Z'), now) ?? '', /1h ago, after the last Run/);
  assert.equal(handoffWarning(handoff, step('2026-10-17T11:30:00Z'), now), null, 'a Run since the hand-off');
  assert.equal(handoffWarning(handoff, { status: 'running', startedAt: '2026-10-17T10:00:00Z' }, now), null);
  assert.equal(handoffWarning({ ...handoff, at: new Date(now - (HANDOFF_WARN_DAYS * 86_400_000 + 1)).toISOString() }, null, now), null, 'older than 7 days');
  assert.equal(handoffWarning(undefined, null, now), null);
});
