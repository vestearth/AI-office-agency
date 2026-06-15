import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { asObject } from './runScanner';

/**
 * Bridges the dashboard "Your name (used on decisions)" field to the CLI task
 * namespace (TASK-<PREFIX>-NNN), maintaining two files:
 *
 * - office.config.local.yaml (gitignored, per-machine): writeLocalPrefix only
 *   writes when no prefix is set yet, so a prefix a team member picked by hand
 *   is never silently replaced.
 * - office.team.yaml (committed, shared): readTeamRegistry/registerPrefix
 *   maintain the PREFIX -> owner map via a comment-preserving textual append.
 *   registerPrefix runs on every name sync — including when a prefix is already
 *   configured — claiming it if unclaimed, idempotent for the same owner, and
 *   reporting a conflict (without writing) when another owner holds it.
 *
 * So a name sync derives+writes both files when no prefix exists, and otherwise
 * just claims the configured prefix in the shared registry.
 */

// Mirrors run-agent.sh intake validation: uppercase, starts with a letter.
const PREFIX_PATTERN = /^[A-Z][A-Z0-9]*$/;
const RESERVED_PREFIXES = new Set(['PKG', 'TASK']);
const MAX_PREFIX_LEN = 5;

export type PrefixSource = 'local-config' | 'base-config';

export interface EffectivePrefix {
  taskPrefix: string | null;
  source: PrefixSource | null;
}

/**
 * Derive a prefix from a display name: initials for multi-word names
 * ("Earth Sripian" -> ES), leading letters for single words ("Earth" -> EAR).
 * Returns null when nothing usable remains (e.g. a Thai-only name) — the
 * caller should ask for a manual prefix instead of guessing.
 */
export function derivePrefixFromName(name: string): string | null {
  return prefixCandidatesFromName(name)[0] ?? null;
}

/**
 * Ordered candidate prefixes for a name, used to dodge registry collisions:
 * initials first, then leading letters of the first word, then numbered
 * variants (ES2..ES9). All candidates are valid, non-reserved prefixes.
 */
export function prefixCandidatesFromName(name: string): string[] {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return [];

  const raw: string[] = [];
  if (words.length >= 2) {
    raw.push(words.map((w) => w[0]).join('').slice(0, MAX_PREFIX_LEN));
  }
  raw.push(words[0].slice(0, 3));

  const bases = raw
    .map((c) => c.toUpperCase().replace(/^[0-9]+/, ''))
    .filter((c) => PREFIX_PATTERN.test(c) && !RESERVED_PREFIXES.has(c));

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const base of bases) {
    if (!seen.has(base)) { seen.add(base); candidates.push(base); }
  }
  for (const base of bases) {
    for (let n = 2; n <= 9; n++) {
      const v = `${base}${n}`;
      if (!seen.has(v)) { seen.add(v); candidates.push(v); }
    }
  }
  return candidates;
}

function localConfigPath(officeRoot: string): string {
  return path.join(officeRoot, 'office.config.local.yaml');
}

async function readYamlFile(filePath: string): Promise<Record<string, any>> {
  try {
    return asObject(yaml.load(await fs.readFile(filePath, 'utf8')));
  } catch {
    return {};
  }
}

function prefixFrom(config: Record<string, any>): string | null {
  const raw = config?.office?.task_prefix;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toUpperCase();
  return value || null;
}

/** Local config wins over base, matching resolve-office-config.rb merge order. */
export async function readEffectivePrefix(officeRoot: string): Promise<EffectivePrefix> {
  const local = prefixFrom(await readYamlFile(localConfigPath(officeRoot)));
  if (local) return { taskPrefix: local, source: 'local-config' };

  const base = prefixFrom(await readYamlFile(path.join(officeRoot, 'office.config.yaml')));
  if (base) return { taskPrefix: base, source: 'base-config' };

  return { taskPrefix: null, source: null };
}

function teamRegistryPath(officeRoot: string): string {
  return path.join(officeRoot, 'office.team.yaml');
}

/**
 * Read the committed team prefix registry (office.team.yaml): PREFIX -> owner
 * display name. Keys normalize to uppercase. Missing/malformed file -> {}.
 */
export async function readTeamRegistry(officeRoot: string): Promise<Record<string, string>> {
  const data = await readYamlFile(teamRegistryPath(officeRoot));
  const raw = asObject(data.prefixes);
  const registry: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const prefix = String(key).trim().toUpperCase();
    if (PREFIX_PATTERN.test(prefix)) registry[prefix] = String(value ?? '');
  }
  return registry;
}

export type RegisterResult = 'registered' | 'already-registered' | 'conflict';

/**
 * Claim a prefix in office.team.yaml for `owner`. The registry is a committed,
 * comment-heavy file, so this edits it textually (insert one line under
 * `prefixes:`) instead of re-dumping YAML — comments survive. Idempotent for
 * the same owner; reports a conflict (without writing) for a different owner.
 */
export async function registerPrefix(
  officeRoot: string,
  prefix: string,
  owner: string,
): Promise<RegisterResult> {
  const existing = await readTeamRegistry(officeRoot);
  const current = existing[prefix];
  if (current !== undefined) {
    return current === owner ? 'already-registered' : 'conflict';
  }

  const filePath = teamRegistryPath(officeRoot);
  let text = '';
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    text = 'prefixes: {}\n';
  }

  // JSON string escaping is valid YAML double-quoted scalar escaping.
  const entry = `  ${prefix}: ${JSON.stringify(owner)}`;
  let updated: string;
  if (/^prefixes:[ \t]*\{[ \t]*\}[ \t]*$/m.test(text)) {
    updated = text.replace(/^prefixes:[ \t]*\{[ \t]*\}[ \t]*$/m, `prefixes:\n${entry}`);
  } else if (/^prefixes:[ \t]*$/m.test(text)) {
    updated = text.replace(/^prefixes:[ \t]*$/m, `prefixes:\n${entry}`);
  } else {
    updated = `${text.replace(/\n*$/, '\n')}prefixes:\n${entry}\n`;
  }

  // The textual edit must still parse and contain the claim — refuse to
  // corrupt a shared committed file.
  const parsed = asObject(yaml.load(updated));
  const parsedPrefixes = asObject(parsed.prefixes);
  if (parsedPrefixes[prefix] !== owner) {
    throw new Error('office.team.yaml edit failed validation');
  }

  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, updated, 'utf8');
  await fs.rename(tmpPath, filePath);
  return 'registered';
}

/**
 * Persist a derived prefix into office.config.local.yaml. Re-dumping through
 * js-yaml drops comments in an existing local file; acceptable because the
 * file is machine-local and small, and we never touch it once a prefix exists.
 */
export async function writeLocalPrefix(officeRoot: string, prefix: string): Promise<void> {
  const filePath = localConfigPath(officeRoot);
  const existing = await readYamlFile(filePath);
  const office = asObject(existing.office);
  const merged = { ...existing, office: { ...office, task_prefix: prefix } };

  const header =
    '# Per-machine overrides (gitignored). task_prefix namespaces intake ids\n' +
    '# (TASK-<PREFIX>-NNN) so machines never allocate the same id — see\n' +
    '# docs/multi-user-git.md. Auto-derived from the dashboard name field;\n' +
    '# edit freely, the dashboard never overwrites an existing value.\n';
  const body = header + yaml.dump(merged, { lineWidth: 100 });

  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, body, 'utf8');
  await fs.rename(tmpPath, filePath);
}
