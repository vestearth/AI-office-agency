#!/usr/bin/env node
/**
 * Local SocratiCode MCP stdio proxy.
 *
 * Used when socraticode-remote falls back to the local Docker backend.
 * Remaps remote-canonical projectPath values (d:\llm) to the local index
 * root so agents can keep sending the primary projectPath unchanged.
 *
 * Speaks MCP stdio (Content-Length framing and newline-delimited JSON).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  resolveLocalProjectRoot,
  resolveRemoteCanonicalProject,
  remapProjectPathToLocal,
} = require("./socraticode-paths.js");

const LOCAL_ROOT = resolveLocalProjectRoot();
const REMOTE_CANONICAL = resolveRemoteCanonicalProject();
const NPX = process.env.SOCRATICODE_LOCAL_COMMAND || "npx";
const NPX_ARGS = process.env.SOCRATICODE_LOCAL_ARGS
  ? process.env.SOCRATICODE_LOCAL_ARGS.split(" ").filter(Boolean)
  : ["-y", "socraticode"];

function remapToolArgs(args) {
  if (!args || typeof args !== "object") return args;
  const next = { ...args };
  if ("projectPath" in next) {
    next.projectPath = remapProjectPathToLocal(
      next.projectPath,
      LOCAL_ROOT,
      REMOTE_CANONICAL
    );
  }
  return next;
}

// socraticode 1.9.0 auto-starts the per-file watcher after every successful
// codebase_update (dist/tools/index-tools.js), and unlike the watch daemon the
// server behind this proxy outlives the call — so that watcher stays, and its
// per-file embedding fan-out is what pinned Docker Ollama at ~1000% CPU twice
// on 2026-08-14. A cross-process codebase_watch stop cannot reach it (the lock
// is advisory), so the stop has to come from this lane. Index freshness is the
// daemon's job; this lane is query-only.
//
// Injected ids are strings so they can never collide with the host's, and
// their responses are swallowed rather than forwarded — the host never asked
// for them and an unsolicited response id would confuse it.
const pendingUpdates = new Map();
const injectedIds = new Set();
let injectedSeq = 0;

function noteUpdateRequest(message) {
  if (message?.method !== "tools/call") return;
  if (message.params?.name !== "codebase_update") return;
  if (message.id === undefined || message.id === null) return;
  const projectPath = message.params?.arguments?.projectPath;
  if (projectPath) pendingUpdates.set(message.id, projectPath);
}

function stopWatcherAfterUpdate(message) {
  if (message?.id === undefined || message.id === null) return;
  const projectPath = pendingUpdates.get(message.id);
  if (projectPath === undefined) return;
  pendingUpdates.delete(message.id);
  const stopId = `proxy-watch-stop-${++injectedSeq}`;
  injectedIds.add(stopId);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: stopId,
      method: "tools/call",
      params: {
        name: "codebase_watch",
        arguments: { action: "stop", projectPath },
      },
    })}\n`
  );
}

function rewriteMessage(message) {
  if (!message || typeof message !== "object") return message;
  if (message.method === "tools/call" && message.params?.arguments) {
    return {
      ...message,
      params: {
        ...message.params,
        arguments: remapToolArgs(message.params.arguments),
      },
    };
  }
  return message;
}

function encodeContentLength(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

function createFramedParser(onMessage) {
  let buffer = Buffer.alloc(0);
  let contentLength = null;
  let headerDone = false;

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (!headerDone) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          const nl = buffer.indexOf("\n");
          if (nl === -1) return;
          const line = buffer.subarray(0, nl).toString("utf8").trim();
          buffer = buffer.subarray(nl + 1);
          if (!line) continue;
          if (/^content-length:/i.test(line)) {
            buffer = Buffer.concat([Buffer.from(`${line}\n`, "utf8"), buffer]);
            return;
          }
          try {
            onMessage(JSON.parse(line), "ndjson");
          } catch {
            // ignore non-JSON noise
          }
          continue;
        }

        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        const match = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          const firstNl = buffer.indexOf("\n");
          if (firstNl === -1) return;
          const line = buffer.subarray(0, firstNl).toString("utf8").trim();
          buffer = buffer.subarray(firstNl + 1);
          if (line) {
            try {
              onMessage(JSON.parse(line), "ndjson");
            } catch {
              // ignore
            }
          }
          continue;
        }
        contentLength = Number(match[1]);
        buffer = buffer.subarray(headerEnd + 4);
        headerDone = true;
      }

      if (contentLength == null || buffer.length < contentLength) return;
      const body = buffer.subarray(0, contentLength).toString("utf8");
      buffer = buffer.subarray(contentLength);
      contentLength = null;
      headerDone = false;
      try {
        onMessage(JSON.parse(body), "framed");
      } catch {
        // ignore malformed
      }
    }
  };
}

const childEnv = {
  ...process.env,
  SOCRATICODE_LOCAL_PROJECT: LOCAL_ROOT,
  // Disable upstream auto-resume (socraticode 1.9.0 startup.js): a set-but-
  // empty project list makes it warn and resume nothing, so the spawned
  // server never auto-starts the per-file watcher whose embedding fan-out
  // pinned Docker Ollama at ~1000% CPU (observed 2026-08-14, this proxy's
  // child held the watch lock and 20 concurrent embed connections). The
  // watch daemon owns index freshness; this lane is query-only.
  SOCRATICODE_AUTO_RESUME_PROJECTS: ",",
  npm_config_cache:
    process.env.SOCRATICODE_NPM_CACHE ||
    (process.env.HOME ? path.join(process.env.HOME, ".npm") : process.env.npm_config_cache),
};

const useProcessGroup = process.platform !== "win32";
const child = spawn(NPX, NPX_ARGS, {
  stdio: ["pipe", "pipe", "inherit"],
  env: childEnv,
  detached: useProcessGroup,
});

const forwardToChild = createFramedParser((message, style) => {
  const rewritten = rewriteMessage(message);
  noteUpdateRequest(rewritten);
  if (style === "framed") {
    child.stdin.write(encodeContentLength(rewritten));
  } else {
    child.stdin.write(`${JSON.stringify(rewritten)}\n`);
  }
});

const forwardToParent = createFramedParser((message, style) => {
  if (message?.id !== undefined && injectedIds.delete(message.id)) return;
  if (style === "framed") {
    process.stdout.write(encodeContentLength(message));
  } else {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
  stopWatcherAfterUpdate(message);
});

process.stdin.on("data", forwardToChild);
child.stdout.on("data", forwardToParent);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try {
    child.stdin.end();
  } catch {
    process.exit(0);
  }
  setTimeout(() => {
    try {
      process.kill(useProcessGroup ? -child.pid : child.pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }, 3000).unref();
  setTimeout(() => {
    try {
      process.kill(useProcessGroup ? -child.pid : child.pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
    process.exit(0);
  }, 5000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();
