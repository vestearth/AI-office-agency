import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import yaml from 'js-yaml';
import type {
  ProdSignalsResponse, RunSummary, SignalClusterState, SignalCoverage, SignalEnv, SignalGroup, SignalTaskRef,
} from '@shared/types';
import { config } from '../config';
import { RunScanner, globalScanner } from './runScanner';

// Command › Attention › Production signals: recurring ERROR log groups from the
// ECS services that are running, matched to the TASK runs whose files mention
// them. The question it answers is "what is failing in production that nobody
// owns yet?" — the operator then asks Claude to open a run; this never writes.
//
// Log classification follows DevOps' aws-tracking (server/utils/logs.ts and
// server/api/reliability/errors.get.ts) so both screens group the same lines.
// Two differences: lines sharing a request/correlation id count as ONE failure
// (aws-tracking counts lines), and every FilterLogEvents page is read.

const CONFIG_PATH = path.resolve(__dirname, '../../../config/prod-signals.yaml');
// 3000 cut the 2026-10-15 KBank outage at 3,809 of 8,189 failures (TASK-VS-028 investigation).
export const MAX_EVENTS_PER_SOURCE = 50_000;
const SOURCE_CONCURRENCY = 2;
const BUDGET_MS = 90_000;
const AWS_CALL_TIMEOUT_MS = 30_000;
const MAX_GROUPS = 60;
const CORPUS_FILES = /^(task\.md|status\.yaml|[a-z0-9-]+-output\.yaml|verification-evidence\.md|investigation\.md|decision-memo\.md)$/;
const MAX_CORPUS_BYTES = 256 * 1024;

// JSON levels are matched as quoted phrases: a bare `error` also hits `"outcome":"error"` on 4xx lines.
const ERROR_TERMS = [
  '"level\\":\\"ERROR"', '"level\\":\\"error"', '"level\\":\\"FATAL"', '"level\\":\\"fatal"',
  '"level\\":\\"PANIC"', '"level\\":\\"panic"',
  'ERROR', 'FATAL', 'PANIC', 'panic', 'Exception', 'Traceback', '"Error:"', '"error:"',
];
export const ERROR_FILTER_PATTERN = ERROR_TERMS.map((t) => `?${t}`).join(' ');

export interface ClusterConfig { cluster: string; env: SignalEnv; product: string; taskPrefix: string }
export interface SignalsConfig {
  awsProfile: string;
  region: string;
  windowHours: number;
  closedWindowDays: number;
  cacheMinutes: number;
  clusters: ClusterConfig[];
}

export async function loadSignalsConfig(file = CONFIG_PATH): Promise<SignalsConfig> {
  const raw = (yaml.load(await fs.readFile(file, 'utf8')) ?? {}) as Record<string, any>;
  const clusters: ClusterConfig[] = (Array.isArray(raw.clusters) ? raw.clusters : []).map((c: Record<string, any>): ClusterConfig => ({
    cluster: String(c.cluster ?? ''),
    env: c.env === 'staging' ? 'staging' : 'prod',
    product: String(c.product ?? c.cluster ?? ''),
    taskPrefix: String(c.task_prefix ?? ''),
  })).filter((c: ClusterConfig) => Boolean(c.cluster));
  return {
    awsProfile: process.env.PROD_SIGNALS_AWS_PROFILE?.trim() || String(raw.aws_profile ?? 'vestearth'),
    region: String(raw.region ?? 'ap-southeast-1'),
    windowHours: Number(raw.window_hours) > 0 ? Number(raw.window_hours) : 24,
    closedWindowDays: Number(raw.closed_window_days) > 0 ? Number(raw.closed_window_days) : 14,
    cacheMinutes: Number(raw.cache_minutes) > 0 ? Number(raw.cache_minutes) : 15,
    clusters,
  };
}

// ---------------------------------------------------------------- parsing

export interface ParsedLine {
  isError: boolean;
  timestamp: number;
  requestKey: string | null;
  msg: string;
  error: string;
  method: string;
  path: string;
  status: number;
}

const LEADING_TIME = /^\d{4}[/-]\d{2}[/-]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*/;
const ERROR_LEVELS = new Set(['fatal', 'panic', 'critical', 'crit', 'error', 'err', 'alert', 'emerg']);

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** One CloudWatch message → the fields signals group on. Non-error lines come back isError=false. */
export function parseLine(message: string, timestamp: number): ParsedLine {
  const text = message.trim();
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      const status = Number(obj.status) || 0;
      const level = str(obj.level ?? obj.severity ?? obj.lvl).toLowerCase();
      const isError = ERROR_LEVELS.has(level) || (!level && status >= 500);
      const rawPath = str(obj.path ?? obj.url ?? obj.uri);
      return {
        isError,
        timestamp,
        requestKey: str(obj.request_id ?? obj.requestId ?? obj['x-correlation-id'] ?? obj.correlation_id ?? obj.trace_id) || null,
        msg: str(obj.msg ?? obj.message),
        error: str(obj.error ?? obj.err ?? obj.error_message),
        method: str(obj.method),
        path: rawPath.split('?')[0] ?? '',
        status,
      };
    } catch {
      // not JSON: fall through to plain text
    }
  }
  const line = text.split('\n')[0]!.replace(LEADING_TIME, '');
  return {
    isError: /\b(fatal|panic|error|exception|traceback)\b/i.test(line),
    timestamp,
    requestKey: null,
    msg: line.slice(0, 300),
    error: '',
    method: '',
    path: '',
    status: 0,
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Collapses ids, numbers and quoted values so repeats of one error share a key (aws-tracking `signature`). */
export function normalizeText(s: string): string {
  return s
    .replace(UUID, '<id>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/"[^"]{24,}"/g, '"…"')
    .replace(/\b\d+(\.\d+)?(ms|s|µs)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** For samples: keep the readable text, hide identifiers and personal data. */
export function redact(s: string): string {
  return s
    .replace(UUID, '<id>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b[A-Z0-9]*\d{6,}[A-Z0-9]*\b/g, '<n>');
}

export interface Failure {
  lines: ParsedLine[];
  timestamp: number;
  method: string;
  path: string;
  status: number;
  msg: string;
  error: string;
}

/** Error lines → failures: lines with the same request/correlation id are one failure. */
export function collapseFailures(lines: ParsedLine[]): Failure[] {
  const byKey = new Map<string, ParsedLine[]>();
  const loose: ParsedLine[][] = [];
  for (const line of lines) {
    if (!line.isError) continue;
    if (line.requestKey) byKey.set(line.requestKey, [...(byKey.get(line.requestKey) ?? []), line]);
    else loose.push([line]);
  }
  return [...byKey.values(), ...loose].map((group) => {
    const pick = (f: (l: ParsedLine) => string | number) => group.map(f).find((v) => v) ?? '';
    // The line carrying an error text explains the failure ("reports request failed" over the access line).
    const explaining = group.find((l) => l.error) ?? group[0]!;
    return {
      lines: group,
      timestamp: Math.max(...group.map((l) => l.timestamp)),
      method: String(pick((l) => l.method)),
      path: String(pick((l) => l.path)),
      status: Number(pick((l) => l.status)) || 0,
      msg: explaining.msg,
      error: explaining.error,
    };
  });
}

/** Normalized text, except the HTTP status, which stays readable ("-> 500"). */
export function failureSignature(f: Failure): string {
  if (f.method || f.path) {
    const http = normalizeText(`${f.method} ${f.path}`) + (f.status ? ` -> ${f.status}` : '');
    return `${http}${f.error ? ` ${normalizeText(f.error)}` : ''}`.slice(0, 220);
  }
  return normalizeText(`${f.msg}${f.error && f.error !== f.msg ? `: ${f.error}` : ''}`).slice(0, 220);
}

/** Text with placeholders removed, for search terms: "bank flow day <n>-<n>-<n>" → "bank flow day". */
function stripPlaceholders(s: string): string {
  return normalizeText(s).replace(/<[a-z]+>/g, ' ').replace(/[\s\-_/.:,;'"`()[\]]+$/, '').replace(/\s[\-_/.:,;]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
}

const GENERIC_PHRASES = /^(timeout|context deadline exceeded|context canceled|request failed|error|internal server error|failed|unknown|authentication failed|unauthorized|forbidden|not found|bad request)$/i;

/** The most specific stable phrase of an error ("count verifications: timeout" → "count verifications"). */
export function errorPhrase(f: Failure): string {
  const candidates = [f.error, f.msg].flatMap((t) => t.split(':')).map(stripPlaceholders);
  return candidates.find((p) => p.split(' ').length >= 2 && p.length >= 8 && !GENERIC_PHRASES.test(p)) ?? '';
}

/** Literal path up to the first id/number segment: "/api/v1/admin/reports/game/<id>" → "/api/v1/admin/reports/game/". */
export function pathTerm(p: string): { term: string; exact: boolean } | null {
  if (!p) return null;
  const norm = normalizeText(p);
  const cut = norm.indexOf('<');
  const term = cut === -1 ? norm : norm.slice(0, cut);
  const segments = term.split('/').filter(Boolean).length;
  // An id-prefix like "/v1/merchants/" is too broad to say a task is about this failure.
  if (segments < 2 || (cut !== -1 && segments < 3)) return null;
  return { term, exact: cut === -1 };
}

export function termsFor(f: Failure): string[] {
  const out: string[] = [];
  const pt = pathTerm(f.path);
  if (pt) out.push(pt.term);
  const phrase = errorPhrase(f);
  if (phrase) out.push(phrase);
  return out;
}

/** A path term counts when it is a whole path token (or a prefix ending at an id); phrases are substrings. */
export function corpusHas(corpus: string, term: string): boolean {
  const t = term.toLowerCase();
  if (!t.startsWith('/')) return corpus.includes(t);
  if (t.endsWith('/')) return corpus.includes(t);
  let at = corpus.indexOf(t);
  while (at !== -1) {
    const next = corpus[at + t.length];
    if (next === undefined || !/[a-z0-9/_-]/.test(next)) return true;
    at = corpus.indexOf(t, at + 1);
  }
  return false;
}

// ---------------------------------------------------------------- grouping

export interface SourceMeta { cluster: ClusterConfig; service: string; logGroup: string }

export function groupFailures(source: SourceMeta, failures: Failure[]): Omit<SignalGroup, 'coverage' | 'mentionedBy' | 'recursAfter' | 'closedRecently'>[] {
  const groups = new Map<string, { failures: Failure[]; signature: string }>();
  for (const f of failures) {
    const signature = failureSignature(f);
    const g = groups.get(signature) ?? { failures: [], signature };
    g.failures.push(f);
    groups.set(signature, g);
  }
  return [...groups.values()].map(({ failures: fs, signature }) => {
    const times = fs.map((f) => f.timestamp).sort((a, b) => a - b);
    const hours = new Set(times.map((t) => Math.floor(t / 3_600_000))).size;
    const latest = fs.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
    const sampleParts = [latest.msg, latest.method && latest.path ? `${latest.method} ${latest.path}` : latest.path, latest.status ? String(latest.status) : '', latest.error]
      .filter(Boolean);
    return {
      key: `${source.cluster.cluster}|${source.service}|${signature}`,
      cluster: source.cluster.cluster,
      product: source.cluster.product,
      taskPrefix: source.cluster.taskPrefix,
      service: source.service,
      logGroup: source.logGroup,
      signature,
      failures: fs.length,
      logLines: fs.reduce((n, f) => n + f.lines.length, 0),
      firstAt: new Date(times[0]!).toISOString(),
      lastAt: new Date(times[times.length - 1]!).toISOString(),
      hours,
      recurring: hours >= 2,
      sample: redact(sampleParts.join(' · ')).slice(0, 600),
      searchPhrase: errorPhrase(latest) || pathTerm(latest.path)?.term || stripPlaceholders(latest.msg).slice(0, 60),
      terms: termsFor(latest),
    };
  });
}

// ---------------------------------------------------------------- coverage

export interface RunCorpus { run: RunSummary; text: string }

const TERMINAL = new Set(['completed', 'cancelled']);

export function classifyCoverage(
  group: Pick<SignalGroup, 'terms' | 'taskPrefix' | 'lastAt'>,
  corpora: RunCorpus[],
  now: Date,
  closedWindowDays: number,
): { coverage: SignalCoverage; mentionedBy: SignalTaskRef[]; recursAfter: SignalTaskRef[]; closedRecently: SignalTaskRef[] } {
  const mentionedBy: SignalTaskRef[] = [];
  const recursAfter: SignalTaskRef[] = [];
  const closedRecently: SignalTaskRef[] = [];
  const prefix = group.taskPrefix ? `TASK-${group.taskPrefix}-` : '';
  const windowStart = now.getTime() - closedWindowDays * 86_400_000;
  for (const { run, text } of corpora) {
    if (prefix && !run.id.startsWith(prefix)) continue;
    const terms = group.terms.filter((t) => corpusHas(text, t));
    if (terms.length === 0) continue;
    const ref: SignalTaskRef = { id: run.id, title: run.title, status: run.status, terms };
    if (!TERMINAL.has(run.status)) {
      mentionedBy.push(ref);
    } else if (run.status === 'completed' && run.completedAt) {
      // A date-only completedAt ("2026-10-14") has no time: count only failures after that Bangkok day ends.
      const closed = /^\d{4}-\d{2}-\d{2}$/.test(run.completedAt)
        ? Date.parse(`${run.completedAt}T23:59:59.999+07:00`)
        : Date.parse(run.completedAt);
      if (closed >= windowStart) {
        (Date.parse(group.lastAt) > closed ? recursAfter : closedRecently).push({ ...ref, completedAt: run.completedAt });
      }
    }
  }
  const byId = (a: SignalTaskRef, b: SignalTaskRef) => b.id.localeCompare(a.id, undefined, { numeric: true });
  mentionedBy.sort(byId);
  recursAfter.sort(byId);
  closedRecently.sort(byId);
  const coverage: SignalCoverage = mentionedBy.length ? 'mentioned'
    : recursAfter.length ? 'recurs_after'
      : closedRecently.length ? 'closed_recently' : 'unowned';
  return { coverage, mentionedBy, recursAfter, closedRecently };
}

export async function readRunCorpus(runPath: string): Promise<string> {
  let names: string[] = [];
  try { names = await fs.readdir(runPath); } catch { return ''; }
  const parts: string[] = [];
  for (const name of names.filter((n) => CORPUS_FILES.test(n)).sort()) {
    try {
      const buf = await fs.readFile(path.join(runPath, name));
      parts.push(buf.subarray(0, MAX_CORPUS_BYTES).toString('utf8'));
    } catch { /* unreadable file: skip */ }
  }
  return parts.join('\n').toLowerCase();
}

// ---------------------------------------------------------------- AWS

export type AwsCall = (args: string[]) => Promise<any>;

export function cliAws(profile: string, region: string): AwsCall {
  return (args) => new Promise((resolve, reject) => {
    execFile('aws', [...args, '--region', region, '--output', 'json'], {
      env: { ...process.env, AWS_PROFILE: profile, AWS_REGION: region, AWS_PAGER: '' },
      timeout: AWS_CALL_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split('\n').pop() || 'aws CLI failed'));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : {}); } catch (e) { reject(e); }
    });
  });
}

interface LogSource { service: string; container: string; logGroup: string; streamPrefix: string }

async function sourcesOf(aws: AwsCall, cluster: string, warnings: string[]): Promise<{ running: number; sources: LogSource[] }> {
  const listed = await aws(['ecs', 'list-services', '--cluster', cluster]);
  const arns: string[] = listed.serviceArns ?? [];
  const services: Record<string, any>[] = [];
  for (let i = 0; i < arns.length; i += 10) {
    const page = await aws(['ecs', 'describe-services', '--cluster', cluster, '--services', ...arns.slice(i, i + 10)]);
    services.push(...(page.services ?? []));
  }
  const running = services.filter((s) => (s.desiredCount ?? 0) > 0 && s.taskDefinition);
  const sources: LogSource[] = [];
  for (const svc of running) {
    const td = await aws(['ecs', 'describe-task-definition', '--task-definition', svc.taskDefinition]);
    for (const c of td.taskDefinition?.containerDefinitions ?? []) {
      const log = c.logConfiguration;
      if (log?.logDriver !== 'awslogs' || !log.options?.['awslogs-group']) {
        warnings.push(`${svc.serviceName}/${c.name}: log driver "${log?.logDriver ?? 'none'}" is not readable here`);
        continue;
      }
      sources.push({ service: svc.serviceName, container: c.name, logGroup: log.options['awslogs-group'], streamPrefix: log.options['awslogs-stream-prefix'] ?? '' });
    }
  }
  return { running: running.length, sources };
}

/** Every FilterLogEvents page in [from, to), until the event cap or the deadline. */
type LogEvent = { message: string; timestamp: number };

/** Every page of one [start, end) window; incomplete when the deadline cut it (its rows are then dropped). */
async function readWindow(aws: AwsCall, src: LogSource, start: number, end: number, deadline: number): Promise<{ events: LogEvent[]; complete: boolean }> {
  const events: LogEvent[] = [];
  let token: string | undefined;
  do {
    const args = ['logs', 'filter-log-events', '--log-group-name', src.logGroup,
      '--start-time', String(start), '--end-time', String(end - 1), '--filter-pattern', ERROR_FILTER_PATTERN, '--no-paginate'];
    if (src.streamPrefix) args.push('--log-stream-name-prefix', `${src.streamPrefix}/${src.container}/`);
    if (token) args.push('--next-token', token);
    const page = await aws(args);
    for (const e of page.events ?? []) events.push({ message: String(e.message ?? ''), timestamp: Number(e.timestamp) || 0 });
    token = page.nextToken || undefined;
    if (token && Date.now() >= deadline) return { events, complete: false };
  } while (token);
  return { events, complete: true };
}

/**
 * Reads newest first, in windows that double (1h, 2h, 4h, …), each read to its last page,
 * so a cut keeps the most recent failures and says how far back it got (`coveredFrom`).
 * The old single forward read stopped at the cap and lost the newest part of a burst.
 */
export async function readErrorEvents(aws: AwsCall, src: LogSource, from: number, to: number, deadline: number):
  Promise<{ events: LogEvent[]; truncated: boolean; stop?: 'cap' | 'deadline'; coveredFrom: number }> {
  const events: LogEvent[] = [];
  let end = to;
  let span = 60 * 60_000;
  while (end > from) {
    const start = Math.max(from, end - span);
    const win = await readWindow(aws, src, start, end, deadline);
    if (!win.complete) return { events, truncated: true, stop: 'deadline', coveredFrom: end };
    events.push(...win.events);
    end = start;
    span *= 2;
    if (end > from && events.length >= MAX_EVENTS_PER_SOURCE) return { events, truncated: true, stop: 'cap', coveredFrom: end };
    if (end > from && Date.now() >= deadline) return { events, truncated: true, stop: 'deadline', coveredFrom: end };
  }
  return { events, truncated: false, coveredFrom: from };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

// ---------------------------------------------------------------- service

export class ProdSignalsService {
  private cache = new Map<SignalEnv, { at: number; value: ProdSignalsResponse }>();
  private inflight = new Map<SignalEnv, Promise<ProdSignalsResponse>>();

  constructor(
    private readonly scanner: RunScanner = globalScanner,
    private readonly loadConfig: () => Promise<SignalsConfig> = loadSignalsConfig,
    private readonly makeAws: (profile: string, region: string) => AwsCall = cliAws,
    private readonly now: () => Date = () => new Date(),
    // RunSummary.runPath is relative to the office root ("runs/<id>"), so read from runsDir.
    private readonly runsDir: string = config.runsDir,
    /**
     * Where the last result per env survives a server restart (a cold CloudWatch read is
     * ~40s). Opt-in: only the server's instance sets it, so tests never read real data.
     */
    private readonly cacheDir?: string,
    /** Time budget for one read across all sources (tests shorten it). */
    private readonly budgetMs: number = BUDGET_MS,
  ) {}

  private cacheFile(env: SignalEnv): string | null {
    return this.cacheDir ? path.join(this.cacheDir, `prod-signals-${env}.json`) : null;
  }

  private async readDiskCache(env: SignalEnv): Promise<{ at: number; value: ProdSignalsResponse } | null> {
    const file = this.cacheFile(env);
    if (!file) return null;
    try {
      const disk = JSON.parse(await fs.readFile(file, 'utf8')) as { at: number; value: ProdSignalsResponse };
      return typeof disk.at === 'number' && disk.value?.env === env ? disk : null;
    } catch {
      return null;
    }
  }

  private async writeDiskCache(env: SignalEnv, entry: { at: number; value: ProdSignalsResponse }): Promise<void> {
    const file = this.cacheFile(env);
    // A failed read (no credentials, AWS down) is not worth keeping across a restart.
    if (!file || entry.value.clusters.some((c) => c.status === 'error')) return;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(entry));
      await fs.rename(`${file}.tmp`, file);
    } catch (err) {
      console.warn('Production signals cache not saved:', err instanceof Error ? err.message : err);
    }
  }

  async get(env: SignalEnv, refresh = false): Promise<ProdSignalsResponse> {
    const cfg = await this.loadConfig();
    if (!refresh && !this.cache.has(env)) {
      const disk = await this.readDiskCache(env);
      if (disk) this.cache.set(env, disk);
    }
    const hit = this.cache.get(env);
    if (!refresh && hit && this.now().getTime() - hit.at < cfg.cacheMinutes * 60_000) return hit.value;
    const job = this.inflight.get(env) ?? this.startBuild(env, cfg);
    // Stale-while-revalidate: an expired result is served at once (a cold read takes 20-40s
    // while a burst sits in the window) and the fresh read continues in the background.
    // An explicit refresh, or no result at all, waits for the read.
    if (!refresh && hit) return { ...hit.value, refreshing: true };
    return job;
  }

  private startBuild(env: SignalEnv, cfg: SignalsConfig): Promise<ProdSignalsResponse> {
    const job = this.build(env, cfg).then(async (value) => {
      const entry = { at: this.now().getTime(), value };
      this.cache.set(env, entry);
      await this.writeDiskCache(env, entry);
      return value;
    }).finally(() => this.inflight.delete(env));
    this.inflight.set(env, job);
    // A background read must never surface as an unhandled rejection.
    job.catch((err) => console.warn('Production signals read failed:', err instanceof Error ? err.message : err));
    return job;
  }

  private async build(env: SignalEnv, cfg: SignalsConfig): Promise<ProdSignalsResponse> {
    const aws = this.makeAws(cfg.awsProfile, cfg.region);
    const now = this.now();
    const to = now.getTime();
    const from = to - cfg.windowHours * 3_600_000;
    const deadline = Date.now() + this.budgetMs;
    const clusters: SignalClusterState[] = [];
    const raw: Omit<SignalGroup, 'coverage' | 'mentionedBy' | 'recursAfter' | 'closedRecently'>[] = [];

    for (const cluster of cfg.clusters.filter((c) => c.env === env)) {
      const state: SignalClusterState = {
        cluster: cluster.cluster, product: cluster.product, taskPrefix: cluster.taskPrefix,
        status: 'ok', servicesRunning: 0, sourcesRead: 0, sourcesWithErrors: 0, truncated: false, warnings: [],
      };
      clusters.push(state);
      try {
        const { running, sources } = await sourcesOf(aws, cluster.cluster, state.warnings);
        state.servicesRunning = running;
        if (running === 0) { state.status = 'not_running'; continue; }
        await mapLimit(sources, SOURCE_CONCURRENCY, async (src) => {
          try {
            const { events, truncated, stop, coveredFrom } = await readErrorEvents(aws, src, from, to, deadline);
            state.sourcesRead++;
            if (truncated) {
              state.truncated = true;
              state.warnings.push(`${src.logGroup}: stopped at the ${stop === 'cap' ? `${MAX_EVENTS_PER_SOURCE}-line cap` : 'time budget'} after ${events.length} matching lines; read back to ${new Date(coveredFrom).toISOString()}, so its counts are minimums`);
            }
            const failures = collapseFailures(events.map((e) => parseLine(e.message, e.timestamp)));
            if (failures.length) state.sourcesWithErrors++;
            const groups = groupFailures({ cluster, service: src.service, logGroup: src.logGroup }, failures);
            raw.push(...(truncated ? groups.map((g) => ({ ...g, partialSince: new Date(coveredFrom).toISOString() })) : groups));
          } catch (err) {
            state.warnings.push(`${src.logGroup}: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      } catch (err) {
        state.status = 'error';
        state.error = err instanceof Error ? err.message : String(err);
      }
    }

    const runs = await this.scanner.listRuns();
    const prefixes = new Set(raw.map((g) => g.taskPrefix).filter(Boolean));
    const corpora: RunCorpus[] = [];
    for (const run of runs) {
      const prefix = run.id.match(/^TASK-([A-Z][A-Z0-9]*)-\d+$/)?.[1];
      if (!prefix || !prefixes.has(prefix)) continue;
      corpora.push({ run, text: await readRunCorpus(path.join(this.runsDir, run.id)) });
    }
    const order: Record<SignalCoverage, number> = { unowned: 0, recurs_after: 1, closed_recently: 2, mentioned: 3 };
    const groups: SignalGroup[] = raw
      .map((g) => ({ ...g, ...classifyCoverage(g, corpora, now, cfg.closedWindowDays) }))
      .sort((a, b) => order[a.coverage] - order[b.coverage] || b.failures - a.failures || b.lastAt.localeCompare(a.lastAt));
    // Counts cover every group; only the list is capped.
    const counts: Record<SignalCoverage, number> = { unowned: 0, recurs_after: 0, closed_recently: 0, mentioned: 0 };
    for (const g of groups) counts[g.coverage]++;
    groups.splice(MAX_GROUPS);
    return {
      generatedAt: now.toISOString(), env, windowHours: cfg.windowHours, closedWindowDays: cfg.closedWindowDays,
      awsProfile: cfg.awsProfile, region: cfg.region, clusters, groups, counts,
    };
  }
}

export const globalProdSignals = new ProdSignalsService(
  globalScanner, loadSignalsConfig, cliAws, () => new Date(), config.runsDir,
  path.join(os.tmpdir(), 'ai-dev-office-dashboard'),
);
