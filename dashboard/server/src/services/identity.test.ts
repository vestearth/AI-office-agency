import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { derivePrefixFromName, readEffectivePrefix, writeLocalPrefix } from './identity';

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

test('derivePrefixFromName never returns reserved prefixes', () => {
  assert.equal(derivePrefixFromName('Pakorn Kongsup Garn'), null); // PKG reserved
});

test('readEffectivePrefix prefers local config over base, null when unset', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  assert.deepEqual(await readEffectivePrefix(root), { taskPrefix: null, source: null });

  await fs.writeFile(path.join(root, 'office.config.yaml'), yaml.dump({ office: { task_prefix: 'BASE' } }));
  assert.deepEqual(await readEffectivePrefix(root), { taskPrefix: 'BASE', source: 'base-config' });

  await fs.writeFile(path.join(root, 'office.config.local.yaml'), yaml.dump({ office: { task_prefix: 'ea' } }));
  assert.deepEqual(await readEffectivePrefix(root), { taskPrefix: 'EA', source: 'local-config' });
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
