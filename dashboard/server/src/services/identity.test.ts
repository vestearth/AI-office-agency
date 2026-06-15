import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import {
  derivePrefixFromName,
  prefixCandidatesFromName,
  readEffectivePrefix,
  readTeamRegistry,
  registerPrefix,
  writeLocalPrefix,
} from './identity';

test('derivePrefixFromName uses initials for multi-word names', () => {
  assert.equal(derivePrefixFromName('Earth Sripian'), 'ES');
  assert.equal(derivePrefixFromName('john ARTHUR doe'), 'JAD');
});

test('derivePrefixFromName uses leading letters for single words', () => {
  assert.equal(derivePrefixFromName('Earth'), 'EAR');
  assert.equal(derivePrefixFromName('bo'), 'BO');
});

test('derivePrefixFromName strips leading digits and rejects unusable names', () => {
  assert.equal(derivePrefixFromName('42nd Street'), 'S'); // initials "4S" -> leading digit stripped
  assert.equal(derivePrefixFromName('เอิร์ธ'), null); // no latin letters
  assert.equal(derivePrefixFromName('   '), null);
  assert.equal(derivePrefixFromName('123'), null);
});

test('derivePrefixFromName skips reserved prefixes and falls back to the next candidate', () => {
  // Initials "PKG" are reserved -> falls through to first-word letters.
  assert.equal(derivePrefixFromName('Pakorn Kongsup Garn'), 'PAK');
  assert.ok(!prefixCandidatesFromName('Pakorn Kongsup Garn').includes('PKG'));
});

test('readEffectivePrefix prefers local config over base, null when unset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  assert.deepEqual(await readEffectivePrefix(root), { taskPrefix: null, source: null });

  await fs.writeFile(path.join(root, 'office.config.yaml'), yaml.dump({ office: { task_prefix: 'BASE' } }));
  assert.deepEqual(await readEffectivePrefix(root), { taskPrefix: 'BASE', source: 'base-config' });

  await fs.writeFile(path.join(root, 'office.config.local.yaml'), yaml.dump({ office: { task_prefix: 'ea' } }));
  assert.deepEqual(await readEffectivePrefix(root), { taskPrefix: 'EA', source: 'local-config' });
});

test('prefixCandidatesFromName orders initials, first-word letters, then numbered variants', () => {
  const c = prefixCandidatesFromName('Earth Sripian');
  assert.equal(c[0], 'ES');
  assert.equal(c[1], 'EAR');
  assert.ok(c.includes('ES2'));
  assert.ok(c.includes('EAR9'));
  assert.deepEqual(prefixCandidatesFromName('Earth').slice(0, 2), ['EAR', 'EAR2']);
  assert.deepEqual(prefixCandidatesFromName('เอิร์ธ'), []);
});

test('readTeamRegistry handles missing file, normalizes keys, drops invalid prefixes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  assert.deepEqual(await readTeamRegistry(root), {});

  await fs.writeFile(
    path.join(root, 'office.team.yaml'),
    'prefixes:\n  ea: Earth\n  BOB: Bob\n  "9X": Bad\n',
  );
  assert.deepEqual(await readTeamRegistry(root), { EA: 'Earth', BOB: 'Bob' });
});

test('registerPrefix claims into an empty flow-style map and preserves comments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  await fs.writeFile(
    path.join(root, 'office.team.yaml'),
    '# header comment stays\nprefixes: {}\n',
  );

  assert.equal(await registerPrefix(root, 'ES', 'Earth Sripian'), 'registered');

  const text = await fs.readFile(path.join(root, 'office.team.yaml'), 'utf8');
  assert.ok(text.startsWith('# header comment stays\n'));
  assert.deepEqual(await readTeamRegistry(root), { ES: 'Earth Sripian' });
});

test('registerPrefix appends to an existing block without touching other entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  await fs.writeFile(
    path.join(root, 'office.team.yaml'),
    '# team registry\nprefixes:\n  EA: Earth\n',
  );

  assert.equal(await registerPrefix(root, 'BOB', 'Bob'), 'registered');
  assert.deepEqual(await readTeamRegistry(root), { EA: 'Earth', BOB: 'Bob' });
  const text = await fs.readFile(path.join(root, 'office.team.yaml'), 'utf8');
  assert.ok(text.includes('# team registry'));
});

test('registerPrefix is idempotent for the same owner and conflicts for another', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  await fs.writeFile(path.join(root, 'office.team.yaml'), 'prefixes:\n  EA: Earth\n');

  assert.equal(await registerPrefix(root, 'EA', 'Earth'), 'already-registered');
  assert.equal(await registerPrefix(root, 'EA', 'Somchai'), 'conflict');
  assert.deepEqual(await readTeamRegistry(root), { EA: 'Earth' });
});

test('registerPrefix creates the registry file when missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  assert.equal(await registerPrefix(root, 'EA', 'Earth'), 'registered');
  assert.deepEqual(await readTeamRegistry(root), { EA: 'Earth' });
});

test('writeLocalPrefix creates the local file and preserves unrelated keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  await fs.writeFile(
    path.join(root, 'office.config.local.yaml'),
    yaml.dump({ loop_guard: { max_iterations: 3 }, office: { name: 'My Office' } }),
  );

  await writeLocalPrefix(root, 'ES');

  const written = yaml.load(await fs.readFile(path.join(root, 'office.config.local.yaml'), 'utf8')) as any;
  assert.equal(written.office.task_prefix, 'ES');
  assert.equal(written.office.name, 'My Office');
  assert.equal(written.loop_guard.max_iterations, 3);
});
