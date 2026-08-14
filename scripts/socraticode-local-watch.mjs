#!/usr/bin/env node
/**
 * Persistent SocratiCode local-backend watch daemon.
 * Managed by LaunchAgent co.sparqlab.socraticode-local-watch (optional).
 *
 * Starts local `socraticode` (Docker: Qdrant + Ollama) and keeps the vector
 * index fresh for the workspace root.
 *
 * We deliberately do NOT call `codebase_watch` here. Upstream's watcher keeps
 * `debounceTimers` keyed per file path, and every timer fires its own
 * `updateProjectIndex`, so a bulk change (branch switch, worktree sync, bulk
 * format) fans out into one concurrent embedding run PER FILE. Observed
 * 2026-07-30: this daemon held 40 simultaneous connections to Ollama, starving
 * the interactive MCP server down to a single slot — its embed calls went to
 * ~5 minutes each and a 575-chunk index sat at 0% for over four minutes.
 *
 * Instead we poll `codebase_update` (documented as running synchronously) on an
 * interval, guarded by an in-flight mutex so ticks can never overlap. That caps
 * this daemon at ONE embedding run at a time by construction. Trade-off: the
 * index is at most one interval stale rather than near-real-time — fine for a
 * background freshness daemon, and it leaves Ollama available for whoever is
 * actually asking questions.
 *
 * Upstream (socraticode 1.9.0 dist/tools/index-tools.js) auto-starts the file
 * watcher BOTH on server startup (auto-resume) and after every successful
 * codebase_update — silently re-enabling the exact per-file fan-out above.
 * Observed 2026-08-14: the auto-resumed watcher kept ~10 concurrent embed runs
 * alive around the clock, pinning Ollama at ~1000% CPU for days. So after
 * every completed update we immediately send codebase_watch stop.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { resolveLocalProjectRoot } = require("./socraticode-paths.js");

const PROJECT = resolveLocalProjectRoot();
const NPX = process.env.SOCRATICODE_LOCAL_COMMAND || "npx";
const NPX_ARGS = process.env.SOCRATICODE_LOCAL_ARGS
  ? process.env.SOCRATICODE_LOCAL_ARGS.split(" ").filter(Boolean)
  : ["-y", "socraticode"];

const childEnv = {
  ...process.env,
  SOCRATICODE_LOCAL_PROJECT: PROJECT,
  // Disable upstream auto-resume (set-but-empty list → resume nothing): this
  // daemon does its own codebase_update ticks, and auto-resume would race the
  // stopWatcher() suppression by starting the watcher asynchronously after
  // boot. Post-update auto-start is still possible upstream, so the
  // stopWatcher() calls below stay.
  SOCRATICODE_AUTO_RESUME_PROJECTS: ",",
  npm_config_cache:
    process.env.SOCRATICODE_NPM_CACHE ||
    (process.env.HOME ? path.join(process.env.HOME, ".npm") : process.env.npm_config_cache),
};

const UPDATE_INTERVAL_MS = (() => {
  const raw = process.env.SOCRATICODE_UPDATE_INTERVAL_MS;
  if (raw === undefined) return 300_000;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 10_000) {
    console.error(
      `[watch-daemon] ignoring SOCRATICODE_UPDATE_INTERVAL_MS="${raw}" (need an integer >= 10000); using 300000`
    );
    return 300_000;
  }
  return num;
})();

const useProcessGroup = process.platform !== "win32";
const srv = spawn(NPX, NPX_ARGS, {
  stdio: ["pipe", "pipe", "inherit"],
  env: childEnv,
  shell: false,
  detached: useProcessGroup,
});

const send = (o) => {
  try {
    srv.stdin.write(`${JSON.stringify(o)}\n`);
  } catch {
    // ignore
  }
};

// The mutex: id of the update currently awaiting a response, or null when idle.
let inFlightId = null;
let inFlightSince = 0;
let nextId = 2;
let stdoutBuf = "";

// Parse line-delimited JSON-RPC so a tick can tell when its update actually
// finished. Without this the mutex would have nothing to release it.
srv.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not a complete JSON-RPC frame; ignore
    }
    if (inFlightId !== null && msg.id === inFlightId) {
      const secs = ((Date.now() - inFlightSince) / 1000).toFixed(1);
      inFlightId = null;
      if (msg.error) {
        console.error(`[watch-daemon] update failed after ${secs}s: ${msg.error.message ?? "unknown error"}`);
      } else {
        console.error(`[watch-daemon] update completed in ${secs}s`);
      }
      stopWatcher();
    }
  }
});

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "watch-daemon", version: "1" },
  },
});

// Undo upstream's watcher auto-start (fire-and-forget; the response is
// ignored — nextId keeps stop and update ids disjoint). Called after every
// completed update AND on a slow interval, because auto-resume starts the
// watcher asynchronously some time after server startup — a single stop at
// boot loses that race.
const stopWatcher = () => {
  send({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: {
      name: "codebase_watch",
      arguments: { action: "stop", projectPath: PROJECT },
    },
  });
};

const tick = () => {
  if (inFlightId !== null) {
    const mins = ((Date.now() - inFlightSince) / 60000).toFixed(1);
    // Never launch a second run — a long update means a big changeset, and
    // stacking runs is exactly the fan-out this daemon exists to avoid.
    console.error(`[watch-daemon] update still running after ${mins}m; skipping this tick`);
    return;
  }
  inFlightId = nextId++;
  inFlightSince = Date.now();
  send({
    jsonrpc: "2.0",
    id: inFlightId,
    method: "tools/call",
    params: {
      name: "codebase_update",
      arguments: { projectPath: PROJECT },
    },
  });
};

let ticker = null;
let watcherKiller = null;

setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  console.error(
    `[watch-daemon] polling codebase_update for ${PROJECT} every ${UPDATE_INTERVAL_MS / 1000}s (max 1 concurrent, watcher suppressed)`
  );
  tick();
  ticker = setInterval(tick, UPDATE_INTERVAL_MS);
  watcherKiller = setInterval(stopWatcher, 300_000);
}, 2500);

srv.on("exit", (code) => {
  console.error(
    `[watch-daemon] socraticode server exited (code=${code}); exiting for launchd restart`
  );
  process.exit(code ?? 1);
});

const stop = () => {
  if (ticker) clearInterval(ticker);
  if (watcherKiller) clearInterval(watcherKiller);
  try {
    srv.stdin.end();
  } catch {
    process.exit(0);
  }
  setTimeout(() => {
    try {
      process.kill(useProcessGroup ? -srv.pid : srv.pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }, 3000).unref();
  setTimeout(() => process.exit(0), 4500).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
