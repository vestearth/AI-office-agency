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
  if (style === "framed") {
    child.stdin.write(encodeContentLength(rewritten));
  } else {
    child.stdin.write(`${JSON.stringify(rewritten)}\n`);
  }
});

const forwardToParent = createFramedParser((message, style) => {
  if (style === "framed") {
    process.stdout.write(encodeContentLength(message));
  } else {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
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
