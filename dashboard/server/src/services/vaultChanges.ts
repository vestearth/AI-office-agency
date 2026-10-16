import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import type { KnowledgeVaultChanges, KnowledgeVaultNote } from '../../../shared/types';

// Knowledge › Vault changes: notes edited in knowledge-base and not committed yet, each
// matched to the audit that applied it. An edit no audit records is the one to look at:
// on 2026-10-16 a re-check killed mid-run (dashboard restart) left three notes edited
// with no audit, and nothing on the page showed it. Read-only: git status/log only.

export interface AppliedChange { reviewFile: string; notePath: string; fingerprint: string; summary: string }
/** A note an audit looked at (notes_reviewed), whether or not it changed it. */
export interface ReviewedNote { reviewFile: string; notePath: string }

/** Audits may write vault paths with the repo prefix; compare without it. */
const vaultPath = (p: string) => p.replace(/^knowledge-base\//, '');

/** `git status --porcelain -z` entries for Markdown notes: [status, path]. */
export function parsePorcelain(out: string): { status: string; path: string }[] {
  const parts = out.split('\0');
  const entries: { status: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.length < 4) continue;
    const status = line.slice(0, 2).trim() || '?';
    entries.push({ status, path: line.slice(3) });
    if (status.startsWith('R') || status.startsWith('C')) i++; // renames carry the old path next
  }
  return entries.filter((e) => e.path.endsWith('.md'));
}

/** 0 = no audit looked at it, 1 = reviewed with no change recorded, 2 = changed by an audit. */
const explained = (n: KnowledgeVaultNote) => (n.applied.length ? 2 : n.reviewedBy.length ? 1 : 0);

export function matchVaultChanges(changed: { status: string; path: string }[], applied: AppliedChange[], reviewed: ReviewedNote[] = []): KnowledgeVaultNote[] {
  return changed.map(({ status, path: notePath }) => ({
    path: notePath,
    status,
    applied: applied.filter((a) => vaultPath(a.notePath) === notePath).map(({ reviewFile, fingerprint, summary }) => ({ reviewFile, fingerprint, summary })),
    reviewedBy: [...new Set(reviewed.filter((r) => vaultPath(r.notePath) === notePath).map((r) => r.reviewFile))],
  })).sort((a, b) => explained(a) - explained(b) || a.path.localeCompare(b.path));
}

type Git = (args: string[]) => Promise<string>;

const gitIn = (repo: string): Git => (args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** Applied changes and reviewed notes recorded by audits written since `since` (the vault's last commit). */
export async function auditsSince(reviewsDir: string, since: number): Promise<{ applied: AppliedChange[]; reviewed: ReviewedNote[] }> {
  let files: string[];
  try { files = (await fs.readdir(reviewsDir)).filter((f) => f.endsWith('.yaml')); } catch { return { applied: [], reviewed: [] }; }
  const out: AppliedChange[] = [];
  const reviewed: ReviewedNote[] = [];
  for (const file of files) {
    const full = path.join(reviewsDir, file);
    try {
      if ((await fs.stat(full)).mtime.getTime() < since) continue;
      const doc = yaml.load(await fs.readFile(full, 'utf8')) as { changes?: unknown; notes_reviewed?: unknown } | null;
      for (const n of Array.isArray(doc?.notes_reviewed) ? doc!.notes_reviewed : []) {
        if (typeof n === 'string') reviewed.push({ reviewFile: file, notePath: n });
      }
      for (const c of Array.isArray(doc?.changes) ? doc!.changes : []) {
        const change = c as { note_path?: unknown; disposition?: unknown; finding_fingerprint?: unknown; summary?: unknown };
        if (change.disposition !== 'applied' || typeof change.note_path !== 'string') continue;
        out.push({ reviewFile: file, notePath: change.note_path, fingerprint: String(change.finding_fingerprint ?? ''), summary: String(change.summary ?? '') });
      }
    } catch { /* unreadable audit: the audits list reports it */ }
  }
  return { applied: out, reviewed };
}

export async function vaultChanges(vaultDir: string, reviewsDir: string, git: Git = gitIn(vaultDir)): Promise<KnowledgeVaultChanges> {
  const [status, lastCommit] = await Promise.all([git(['status', '--porcelain', '-z', '--untracked-files=all']), git(['log', '-1', '--format=%cI'])]);
  const lastCommitAt = lastCommit.trim() || null;
  const since = lastCommitAt ? Date.parse(lastCommitAt) : 0;
  const { applied, reviewed } = await auditsSince(reviewsDir, since);
  const notes = matchVaultChanges(parsePorcelain(status), applied, reviewed);
  return { lastCommitAt, notes, unrecorded: notes.filter((n) => explained(n) === 0).length };
}
