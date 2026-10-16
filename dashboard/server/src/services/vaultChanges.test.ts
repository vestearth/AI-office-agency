import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { matchVaultChanges, parsePorcelain, vaultChanges } from './vaultChanges';

test('porcelain -z keeps Markdown notes, handles spaces, untracked and renames', () => {
  const out = [' M Knowledge Base/20 Flows/Deploy Topology Map.md', '?? Knowledge Base/New Note.md', 'R  Knowledge Base/B.md', 'Knowledge Base/A.md', ' M .obsidian/workspace.json', ''].join('\0');
  assert.deepEqual(parsePorcelain(out), [
    { status: 'M', path: 'Knowledge Base/20 Flows/Deploy Topology Map.md' },
    { status: '??', path: 'Knowledge Base/New Note.md' },
    { status: 'R', path: 'Knowledge Base/B.md' },
  ]);
});

test('a changed note with no applied change from an audit since the last commit is unrecorded, and listed first', async () => {
  // 2026-10-16: a re-check killed mid-run left 3 of 12 changed notes with no audit.
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  const reviews = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-'));
  fs.writeFileSync(path.join(reviews, '20261016T082044Z-weekly-recheck.yaml'), [
    'changes:',
    '  - note_path: "Knowledge Base/20 Flows/Missions Workflow Map.md"',
    '    disposition: applied',
    '    finding_fingerprint: fp-1',
    '    summary: cited the weekly fallback removal',
    '  - note_path: "Knowledge Base/20 Flows/Games Labs Service Graph.md"',
    '    disposition: proposed',
    '    finding_fingerprint: fp-2',
  ].join('\n'));
  const git = async (args: string[]) => (args[0] === 'log' ? '2026-10-16T01:32:55+07:00\n'
    : [' M Knowledge Base/20 Flows/Missions Workflow Map.md', ' M Knowledge Base/20 Flows/Games Labs Service Graph.md', ''].join('\0'));
  const result = await vaultChanges(vault, reviews, git);
  assert.equal(result.unrecorded, 1);
  assert.deepEqual(result.notes.map((n) => [n.path, n.applied.map((a) => a.fingerprint)]), [
    ['Knowledge Base/20 Flows/Games Labs Service Graph.md', []],
    ['Knowledge Base/20 Flows/Missions Workflow Map.md', ['fp-1']],
  ]);
});

test('audits written before the last vault commit do not explain current edits', () => {
  const notes = matchVaultChanges([{ status: 'M', path: 'a.md' }], []);
  assert.deepEqual(notes, [{ path: 'a.md', status: 'M', applied: [] }]);
});
