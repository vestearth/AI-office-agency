import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  claudeSettings, cursorSandboxPolicy, displayCommand, gitExclude, missingFromHelp, prepareWorkspace, requiredHelpTokens, stepArgs, stepEnv,
} from './cliAdapter';

const envelope = { cwd: '/ws/repo', writableDirs: ['/ws/office/runs/TASK-1'] };
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-adapter-')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('claude: stream-json, the runs dir, no prompts, user settings only, sandboxed Bash with no network', () => {
  assert.deepEqual(stepArgs('claude', { ...envelope, model: 'claude-opus-5-5' }), [
    '-p', '--model', 'claude-opus-5-5', '--output-format', 'stream-json', '--verbose', '--add-dir', '/ws/office/runs/TASK-1',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--setting-sources', 'user', '--no-session-persistence',
    '--settings', claudeSettings(),
  ]);
  assert.ok(!stepArgs('claude', envelope).includes('--model'), 'no model: the CLI default');
  assert.deepEqual(JSON.parse(claudeSettings()), {
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, network: { allowedDomains: [], strictAllowlist: true } },
    permissions: { allow: ['Edit', 'Write', 'Read'], deny: ['Bash(git push *)', 'WebFetch', 'WebSearch'] },
  });
  assert.deepEqual(JSON.parse(claudeSettings(['Bash(rm *)'])).permissions.deny.at(-1), 'Bash(rm *)');
});

test('codex: pinned model, JSONL, workspace-write in the working dir plus the runs dir, no network, no approvals, stdin', () => {
  const args = stepArgs('codex', envelope);
  assert.deepEqual(args, [
    'exec', '-m', 'gpt-5.6-sol', '--json', '-s', 'workspace-write', '-C', '/ws/repo', '--add-dir', '/ws/office/runs/TASK-1',
    '-c', 'sandbox_workspace_write.network_access=false', '-c', 'approval_policy="never"', '--ephemeral', '-',
  ]);
  assert.ok(!args.includes('--skip-git-repo-check'));
  assert.equal(stepArgs('codex', { ...envelope, model: 'gpt-5.6-terra' })[2], 'gpt-5.6-terra');
});

test('cursor-agent: stream-json in its sandbox; --trust only for a dashboard-created working dir', () => {
  assert.deepEqual(stepArgs('cursor-agent', envelope), ['-p', '--output-format', 'stream-json', '--sandbox', 'enabled', '--workspace', '/ws/repo']);
  assert.deepEqual(stepArgs('cursor-agent', { ...envelope, trustWorkspace: true }), ['-p', '--output-format', 'stream-json', '--sandbox', 'enabled', '--trust', '--workspace', '/ws/repo']);
  assert.deepEqual(cursorSandboxPolicy(['/r']), { type: 'workspace_readwrite', additionalReadwritePaths: ['/r'], networkPolicy: { default: 'deny' } });
});

test('the help probe looks for every flag the adapter passes, matched as whole words', () => {
  assert.deepEqual(requiredHelpTokens('codex'), ['-m', '--json', '-s', '-C', '--add-dir', '-c', '--ephemeral', 'workspace-write']);
  assert.ok(requiredHelpTokens('claude').includes('--setting-sources'));
  assert.ok(requiredHelpTokens('claude').includes('dontAsk'));
  assert.ok(requiredHelpTokens('cursor-agent').includes('--trust'));
  const help = [
    '  -m, --model <MODEL>', '      --json', '  -s, --sandbox <SANDBOX_MODE>', '          [possible values: read-only, workspace-write, danger-full-access]',
    '  -C, --cd <DIR>', '      --add-dir <DIR>', '  -c, --config <key=value>', '      --ephemeral',
  ].join('\n');
  assert.deepEqual(missingFromHelp(help, requiredHelpTokens('codex')), []);
  assert.deepEqual(missingFromHelp(help.replace('--ephemeral', '--ephemeral-mode'), requiredHelpTokens('codex')), ['--ephemeral']);
  assert.deepEqual(missingFromHelp('  --model-name <m>', ['-m', '--model']), ['-m', '--model']);
  assert.deepEqual(missingFromHelp('(choices: "acceptEdits", "dontAsk")', ['dontAsk']), []);
});

test('the environment points Go at a build cache inside the working dir and keeps the rest', () => {
  const env = stepEnv('/ws/repo', { PATH: '/bin', GOCACHE: '/Users/x/Library/Caches/go-build' });
  assert.deepEqual(env, { PATH: '/bin', GOCACHE: path.join('/ws/repo', '.cache', 'go-build') });
});

test('cursor-agent gets .cursor/sandbox.json; .cursor/ and .cache/ go to the repo info/exclude, not .gitignore', () => {
  const repo = tmp();
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  prepareWorkspace('cursor-agent', { cwd: repo, writableDirs: ['/office/runs/TASK-1'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.cursor', 'sandbox.json'), 'utf8')), cursorSandboxPolicy(['/office/runs/TASK-1']));
  assert.ok(fs.statSync(path.join(repo, '.cache', 'go-build')).isDirectory());
  const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/\.cache\/$/m);
  assert.match(exclude, /^\/\.cursor\/$/m);
  assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), 'node_modules\n');
  assert.equal(git(repo, 'status', '--porcelain'), '?? .gitignore\n', 'the step files do not show as changes');
  // A second step adds no duplicate lines and refreshes the writable path.
  prepareWorkspace('cursor-agent', { cwd: repo, writableDirs: ['/office/runs/TASK-2'] });
  assert.equal(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), exclude);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.cursor', 'sandbox.json'), 'utf8')).additionalReadwritePaths, ['/office/runs/TASK-2']);
});

test('in a linked worktree the exclude lands in the common git dir that git reads', () => {
  const repo = tmp();
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(tmp(), 'wt');
  git(repo, 'worktree', 'add', '-q', wt);
  prepareWorkspace('claude', { cwd: wt, writableDirs: [] });
  assert.equal(git(wt, 'status', '--porcelain'), '');
  assert.equal(gitExclude(wt)?.excludeFile, path.join(repo, '.git', 'info', 'exclude'));
  assert.ok(!fs.existsSync(path.join(wt, '.cursor')), 'only cursor-agent gets a sandbox file');
});

test('a working dir below the repo root gets anchored lines; outside git nothing is excluded', () => {
  const repo = tmp();
  git(repo, 'init', '-q');
  const sub = path.join(repo, 'svc');
  fs.mkdirSync(sub);
  prepareWorkspace('claude', { cwd: sub, writableDirs: [] });
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/svc\/\.cache\/$/m);
  const plain = tmp();
  assert.equal(gitExclude(plain), null);
  prepareWorkspace('cursor-agent', { cwd: plain, writableDirs: [] });
  assert.ok(fs.existsSync(path.join(plain, '.cursor', 'sandbox.json')));
});

test('a sandbox.json the dashboard did not write is never replaced', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.cursor'));
  const theirs = '{"type":"insecure_none"}';
  fs.writeFileSync(path.join(dir, '.cursor', 'sandbox.json'), theirs);
  assert.throws(() => prepareWorkspace('cursor-agent', { cwd: dir, writableDirs: [] }), /not a deny-network workspace policy/);
  assert.equal(fs.readFileSync(path.join(dir, '.cursor', 'sandbox.json'), 'utf8'), theirs);
  fs.writeFileSync(path.join(dir, '.cursor', 'sandbox.json'), 'not json');
  assert.throws(() => prepareWorkspace('cursor-agent', { cwd: dir, writableDirs: [] }), /will not replace/);
});

test('the command shown quotes JSON and spaced arguments', () => {
  assert.equal(displayCommand('codex', ['exec', '-c', 'approval_policy="never"', '-']), `codex exec -c 'approval_policy="never"' -`);
  assert.equal(displayCommand('claude', ['--settings', '{"a":1}']), `claude --settings '{"a":1}'`);
});
