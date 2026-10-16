import { StringDecoder } from 'string_decoder';
import type { TaskCli } from './officeLauncher';

// Run › live progress (docs/start-task-redesign-spec.md, D2/D7): each CLI streams
// JSON events (claude and cursor-agent stream-json, codex exec --json JSONL); the
// server turns them into short readable lines (assistant text, tool calls, the
// final result) and notices a protocol failure, which fails the step even when
// the CLI exits 0. The raw log stays on disk. Event shapes were confirmed against
// the installed CLIs on 2026-10-17 (claude 2.1.285, codex 0.157.1, cursor-agent
// 2026.10.14):
//   claude:       system/init, assistant {message.content: text | tool_use},
//                 user {tool_result, is_error}, result {subtype, is_error, result}
//   codex:        thread.started, item.started/item.completed {agent_message |
//                 command_execution | file_change | error (a warning)},
//                 turn.completed, turn.failed {error.message}, error {message}
//   cursor-agent: system/init, assistant, tool_call started/completed
//                 {tool_call.<name>ToolCall {args, result}}, result (as claude)
// A line that is not JSON (stderr, the wrapper's own messages) is kept as is.

/** Progress lines kept per launch (the newest). */
export const PROGRESS_LINES = 200;
const LINE_CHARS = 400;
const RESULT_CHARS = 1500;

export interface StreamSummary {
  progress: string[];
  /** A protocol failure: an error result or event, whatever the exit code says. */
  failure?: string;
  /** The terminal event arrived (claude/cursor `result`, codex `turn.completed` or `turn.failed`). */
  finished: boolean;
}

interface Parsed { lines?: string[]; failure?: string; finished?: boolean }

/** One line of text: whitespace collapsed, clipped. */
export function clip(text: unknown, max = LINE_CHARS): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

/** The most telling argument of a tool call: the command, the file, the pattern… */
function toolTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'globPattern', 'url', 'query', 'description']) {
    const v = str(o[key]);
    if (v) return clip(v, 160);
  }
  return '';
}

const tool = (name: string, input: unknown) => {
  const target = toolTarget(input);
  return `→ ${name}${target ? `: ${target}` : ''}`;
};

/** An error message that is itself JSON (codex wraps the API's error body). */
function errorText(message: unknown): string {
  const raw = String(message ?? '');
  try {
    const inner = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
    const text = str(inner?.error?.message) ?? str(inner?.message);
    if (text) return clip(text);
  } catch { /* plain text */ }
  return clip(raw) || 'unknown error';
}

/** claude and cursor-agent end with the same `result` event. */
function resultEvent(e: Record<string, unknown>): Parsed {
  const subtype = String(e.subtype ?? '');
  if (e.is_error === true || subtype.startsWith('error')) {
    const errors = Array.isArray(e.errors) ? e.errors.map(String).join('; ') : '';
    return { finished: true, failure: clip(str(e.result) ?? (errors || subtype || 'error result'), RESULT_CHARS) };
  }
  const result = str(e.result);
  return { finished: true, lines: [result ? `Result: ${clip(result, RESULT_CHARS)}` : 'Finished.'] };
}

function claude(e: Record<string, unknown>): Parsed {
  const content = (e.message as { content?: unknown } | undefined)?.content;
  const items = Array.isArray(content) ? content as Record<string, unknown>[] : [];
  switch (e.type) {
    case 'system':
      return e.subtype === 'init' ? { lines: [`Session started${str(e.model) ? ` · model ${e.model}` : ''}`] } : {};
    case 'assistant':
      return { lines: items.flatMap((c) => c.type === 'text' && str(c.text) ? [clip(c.text)] : c.type === 'tool_use' ? [tool(String(c.name), c.input)] : []) };
    case 'user':
      return { lines: items.filter((c) => c.type === 'tool_result' && c.is_error === true).map((c) => {
        const body = Array.isArray(c.content) ? (c.content as { text?: unknown }[]).map((x) => x.text ?? '').join(' ') : c.content;
        return `✗ ${clip(body) || 'tool error'}`;
      }) };
    case 'result':
      return resultEvent(e);
    default:
      return {};
  }
}

function codex(e: Record<string, unknown>): Parsed {
  const item = (e.item ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'thread.started': return { lines: ['Session started'] };
    case 'turn.completed': return { finished: true, lines: ['Turn completed.'] };
    case 'turn.failed': return { finished: true, failure: errorText((e.error as { message?: unknown } | undefined)?.message) };
    case 'error': return { failure: errorText(e.message) };
    case 'item.started':
      return item.type === 'command_execution' ? { lines: [`→ $ ${clip(item.command, 160)}`] } : {};
    case 'item.completed':
      switch (item.type) {
        case 'agent_message': return str(item.text) ? { lines: [clip(item.text)] } : {};
        case 'command_execution':
          return typeof item.exit_code === 'number' && item.exit_code !== 0 ? { lines: [`✗ exit ${item.exit_code}: ${clip(item.command, 160)}`] } : {};
        case 'file_change':
          return { lines: (Array.isArray(item.changes) ? item.changes as { path?: unknown; kind?: unknown }[] : []).map((c) => `→ ${c.kind ?? 'change'} ${clip(c.path, 200)}`) };
        // A non-fatal notice (e.g. "Model metadata … not found"): the turn goes on.
        case 'error': return { lines: [`warning: ${errorText(item.message)}`] };
        case 'mcp_tool_call': return { lines: [`→ ${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`] };
        case 'web_search': return { lines: [`→ web search: ${clip(item.query, 160)}`] };
        default: return {};
      }
    default:
      return {};
  }
}

function cursor(e: Record<string, unknown>): Parsed {
  switch (e.type) {
    case 'system':
      return e.subtype === 'init' ? { lines: [`Session started${str(e.model) ? ` · model ${e.model}` : ''}`] } : {};
    case 'assistant': {
      const content = (e.message as { content?: unknown } | undefined)?.content;
      const items = Array.isArray(content) ? content as Record<string, unknown>[] : [];
      return { lines: items.filter((c) => c.type === 'text' && str(c.text)).map((c) => clip(c.text)) };
    }
    case 'tool_call': {
      const call = (e.tool_call ?? {}) as Record<string, unknown>;
      const key = Object.keys(call).find((k) => k.endsWith('ToolCall'));
      if (!key) return {};
      const name = key.replace(/ToolCall$/, '');
      const body = (call[key] ?? {}) as { args?: unknown; result?: Record<string, unknown> };
      if (e.subtype === 'started') return { lines: [tool(name, body.args)] };
      if (e.subtype !== 'completed' || !body.result) return {};
      const [outcome] = Object.keys(body.result);
      const detail = body.result[outcome] as Record<string, unknown> | undefined;
      if (outcome === 'success') {
        return typeof detail?.exitCode === 'number' && detail.exitCode !== 0 ? { lines: [`✗ ${name} exit ${detail.exitCode}`] } : {};
      }
      // e.g. {rejected: {path, reason}}: the edit tool refuses a path outside --workspace (seen 2026-10-17).
      const why = str(detail?.message) ?? str(detail?.reason);
      return { lines: [`✗ ${name} ${outcome}${why ? `: ${clip(why)}` : ''}`] };
    }
    case 'result':
      return resultEvent(e);
    default:
      return {};
  }
}

const PARSERS: Record<TaskCli, (e: Record<string, unknown>) => Parsed> = { claude, codex, 'cursor-agent': cursor };

/** Fed the raw output in chunks as it grows; the summary is ready at any point. */
export class StreamProgress {
  private readonly decoder = new StringDecoder('utf8');
  private partial = '';
  private readonly lines: string[] = [];
  private failure?: string;
  private finished = false;

  constructor(readonly cli: TaskCli) {}

  push(chunk: Buffer | string) {
    this.partial += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const parts = this.partial.split('\n');
    this.partial = parts.pop() ?? '';
    for (const part of parts) this.line(part);
  }

  /** The output is complete (the process ended): parse what is left. */
  end() {
    this.partial += this.decoder.end();
    if (this.partial) this.line(this.partial);
    this.partial = '';
  }

  summary(): StreamSummary {
    return { progress: [...this.lines], ...(this.failure ? { failure: this.failure } : {}), finished: this.finished };
  }

  private line(raw: string) {
    const text = raw.trim();
    if (!text) return;
    let event: unknown;
    try { event = JSON.parse(text); } catch { return this.add([clip(text)]); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return this.add([clip(text)]);
    const parsed = PARSERS[this.cli](event as Record<string, unknown>);
    if (parsed.finished) this.finished = true;
    // The first failure is the cause; codex repeats it (error, then turn.failed): show it once.
    if (parsed.failure && parsed.failure !== this.failure) {
      if (!this.failure) this.failure = parsed.failure;
      this.add([`✗ ${parsed.failure}`]);
    }
    if (parsed.lines) this.add(parsed.lines);
  }

  private add(lines: string[]) {
    this.lines.push(...lines.filter(Boolean));
    if (this.lines.length > PROGRESS_LINES) this.lines.splice(0, this.lines.length - PROGRESS_LINES);
  }
}
