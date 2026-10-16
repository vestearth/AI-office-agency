import test from 'node:test';
import assert from 'node:assert/strict';
import { CliProbe, claudeLogin, codexLogin, codexModelAllowed, cursorLogin, type ProbeExec, type ProbeResult } from './cliProbe';
import type { TaskCli } from './officeLauncher';

const ok = (stdout: string, code = 0): ProbeResult => ({ code, stdout, stderr: '' });

// Help texts listing every flag the adapter passes (shapes of the installed CLIs' help).
const HELP: Record<TaskCli, string> = {
  claude: [
    '  --add-dir <directories...>', '  --model <model>', '  --no-session-persistence', '  --output-format <format>   "text", "json", or "stream-json"',
    '  --permission-mode <mode>   (choices: "acceptEdits", "auto", "dontAsk", "plan")', '  --permission-prompts <target>', '  -p, --print',
    '  --setting-sources <sources>', '  --settings <file-or-json>', '  --verbose',
  ].join('\n'),
  codex: [
    '  -m, --model <MODEL>', '  -s, --sandbox <SANDBOX_MODE>', '     [possible values: read-only, workspace-write, danger-full-access]',
    '  -C, --cd <DIR>', '      --add-dir <DIR>', '  -c, --config <key=value>', '      --ephemeral', '      --json',
  ].join('\n'),
  'cursor-agent': [
    '  -p, --print', '  --output-format <format>  text | json | stream-json', '  --sandbox <mode>', '  --trust', '  --workspace <path-or-name>',
  ].join('\n'),
};

const CURSOR_STATUS = JSON.stringify({ status: 'ok', isAuthenticated: true, hasAccessToken: true, userInfo: { email: 'person@example.com', userId: 42, firstName: 'Pat' } });

/** A fake exec answering help, login and nothing else; calls are recorded. */
function fakeExec(over: Partial<Record<string, ProbeResult>> = {}) {
  const calls: string[] = [];
  const exec: ProbeExec = async (exe, args) => {
    const cli = exe.command.split('/').pop() as TaskCli;
    const key = `${cli} ${args.join(' ')}`;
    calls.push(key);
    if (over[key]) return over[key]!;
    if (args.includes('--help')) return ok(HELP[cli]);
    if (key === 'claude auth status') return ok('{"loggedIn":true,"email":"person@example.com"}');
    if (key === 'codex login status') return ok('Logged in using ChatGPT');
    if (key === 'cursor-agent status --format json') return ok(CURSOR_STATUS);
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { exec, calls };
}

const CATALOG = JSON.stringify({ models: [{ slug: 'auto' }, { slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }] });

const probe = (over: Partial<Record<string, ProbeResult>> = {}, deps: Partial<ConstructorParameters<typeof CliProbe>[0]> = {}) => {
  const fake = fakeExec(over);
  let now = 0;
  const p = new CliProbe({
    find: (name) => ({ command: `/bin/${name}`, prefix: [] }), exec: fake.exec, platform: 'darwin',
    codexCatalogFile: '/home/.codex/model-catalogs/auto.json', readFile: () => CATALOG, codexModel: 'gpt-5.6-sol', now: () => now, ...deps,
  });
  return { p, calls: fake.calls, tick: (ms: number) => { now += ms; } };
};

test('all three are usable when installed, compatible and logged in; codex names its model, the others say the model was not checked', async () => {
  const { p } = probe();
  const all = await p.all();
  assert.deepEqual(all.map((u) => [u.id, u.usable]), [['claude', true], ['codex', true], ['cursor-agent', true]]);
  assert.equal(all[1].model, 'gpt-5.6-sol');
  assert.match(all[0].note ?? '', /model not checked/);
  assert.match(all[2].note ?? '', /model not checked/);
  assert.deepEqual(all[0].executable, { command: '/bin/claude', prefix: [] });
});

test('not installed, Windows, or a help text missing a flag each say why', async () => {
  assert.equal((await probe({}, { find: () => null }).p.usability('codex')).reason, 'codex is not on the dashboard server PATH');
  assert.match((await probe({}, { platform: 'win32' }).p.usability('claude')).reason ?? '', /not enabled on Windows/);
  const old = await probe({ 'codex exec --help': ok(HELP.codex.replace('--ephemeral', '')) }).p.usability('codex');
  assert.equal(old.usable, false);
  assert.match(old.reason ?? '', /`codex exec --help` does not list --ephemeral/);
  const noStream = await probe({ 'cursor-agent --help': ok(HELP['cursor-agent'].replace('stream-json', '')) }).p.usability('cursor-agent');
  assert.match(noStream.reason ?? '', /does not list stream-json/);
});

test('claude login: JSON loggedIn true only', () => {
  assert.equal(claudeLogin(ok('{"loggedIn":true}')), null);
  assert.match(claudeLogin(ok('{"loggedIn":false}', 1)) ?? '', /not logged in/);
  assert.match(claudeLogin({ code: null, stdout: '', stderr: '', error: 'timed out after 10 s' }) ?? '', /timed out after 10 s/);
});

test('codex login: "Not logged in" is not logged in, though it contains "logged in"', () => {
  // The aborted TASK-EAR-404 branch tested /logged in/i, which "Not logged in" also matches.
  assert.equal(codexLogin(ok('Logged in using ChatGPT')), null);
  assert.equal(codexLogin({ code: 0, stdout: '', stderr: 'Logged in using an API key' }), null);
  assert.match(codexLogin(ok('Not logged in', 1)) ?? '', /^not logged in/);
  assert.match(codexLogin(ok('', 1)) ?? '', /could not tell/);
});

test('cursor-agent login: only isAuthenticated is read, and no other field of the status ever reaches the result', async () => {
  assert.equal(cursorLogin(ok(CURSOR_STATUS)), null);
  const out = JSON.stringify({ isAuthenticated: false, userInfo: { email: 'person@example.com', userId: 42 } });
  const reason = cursorLogin(ok(out)) ?? '';
  assert.match(reason, /not logged in/);
  assert.match(cursorLogin(ok('Logged in as person@example.com')) ?? '', /no JSON/);
  for (const r of [reason, cursorLogin(ok('Logged in as person@example.com')) ?? '']) {
    assert.ok(!/person@example\.com|42|Pat/.test(r), r);
  }
  const usable = await probe().p.usability('cursor-agent');
  assert.ok(!JSON.stringify(usable).includes('person@example.com'));
  const denied = await probe({ 'cursor-agent status --format json': ok(out) }).p.usability('cursor-agent');
  assert.equal(denied.usable, false);
  assert.ok(!JSON.stringify(denied).includes('person@example.com'));
});

test('codex model: must be in the account catalog; a missing or broken catalog cannot confirm it', async () => {
  assert.equal(codexModelAllowed(CATALOG, 'gpt-5.6-sol', 'f'), null);
  assert.match(codexModelAllowed(CATALOG, 'gpt-6.1-sol', 'f') ?? '', /gpt-6\.1-sol is not in the account catalog .*auto, gpt-5\.6-sol, gpt-5\.6-terra/);
  assert.match(codexModelAllowed(null, 'gpt-5.6-sol', 'f') ?? '', /f is missing/);
  assert.match(codexModelAllowed('{', 'gpt-5.6-sol', 'f') ?? '', /not JSON/);
  const rejected = await probe({}, { codexModel: 'gpt-6.1-sol' }).p.usability('codex');
  assert.deepEqual([rejected.usable, rejected.model], [false, 'gpt-6.1-sol']);
});

test('checks stop at the first failure and results are cached for 15 s', async () => {
  const { p, calls, tick } = probe({ 'claude --help': ok('nothing useful') });
  await p.usability('claude');
  assert.deepEqual(calls, ['claude --help'], 'no login probe after the help check failed');
  await p.usability('claude');
  tick(14_999);
  await p.usability('claude');
  assert.equal(calls.length, 1, 'cached');
  tick(2);
  await p.usability('claude');
  assert.equal(calls.length, 2, 're-probed after 15 s');
});
