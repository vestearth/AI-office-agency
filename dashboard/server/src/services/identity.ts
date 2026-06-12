import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { asObject } from './runScanner';

/**
 * Bridges the dashboard "Your name (used on decisions)" field to the CLI task
 * namespace: derives a TASK-<PREFIX>-NNN prefix from the name and persists it
 * to office.config.local.yaml (gitignored, per-machine) where
 * run-agent.sh intake reads it. An explicitly configured prefix always wins —
 * we only ever write when no prefix is set yet, so a team member who picked
 * their own prefix never has it silently replaced.
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
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return null;

  let candidate =
    words.length >= 2
      ? words.map((w) => w[0]).join('').slice(0, MAX_PREFIX_LEN)
      : words[0].slice(0, 3);
  candidate = candidate.toUpperCase().replace(/^[0-9]+/, '');

  if (!PREFIX_PATTERN.test(candidate) || RESERVED_PREFIXES.has(candidate)) return null;
  return candidate;
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
