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

const LOCAL_ROOT =
  process.env.SOCRATICODE_LOCAL_PROJECT || "/Users/earth/Documents/GitHub";
const REMOTE_CANONICAL =
  process.env.SOCRATICODE_REMOTE_CANONICAL_PROJECT || "D:\\llm";
const NPX = process.env.SOCRATICODE_LOCAL_COMMAND || "/usr/local/bin/npx";
const NPX_ARGS = process.env.SOCRATICODE_LOCAL_ARGS
  ? process.env.SOCRATICODE_LOCAL_ARGS.split(" ").filter(Boolean)
  : ["-y", "socraticode"];

function normalizePathKey(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function remapProjectPath(value) {
  if (value == null || value === "") return value;
  const raw = String(value);
  const norm = normalizePathKey(raw);
  const remoteNorm = normalizePathKey(REMOTE_CANONICAL);
  const localNorm = normalizePathKey(LOCAL_ROOT);

  if (norm === remoteNorm || norm === "d:/llm") {
    return LOCAL_ROOT;
  }

  if (norm.startsWith(`${remoteNorm}/`) || norm.startsWith("d:/llm/")) {
    const suffix = raw.replace(/^.*?[\\/]llm[\\/]/i, "").replace(/^[/\\]+/, "");
    return suffix ? `${LOCAL_ROOT}/${suffix.replace(/\\/g, "/")}` : LOCAL_ROOT;
  }

  // Relative join mangling: cwd + "d:\llm" → ".../GitHub/d:\llm"
  const mangled = `${localNorm}/d:/llm`;
  if (norm === mangled || norm.startsWith(`${mangled}/`)) {
    const suffix = norm.slice(mangled.length).replace(/^\/+/, "");
    return suffix ? `${LOCAL_ROOT}/${suffix}` : LOCAL_ROOT;
  }

  return raw;
}

function remapToolArgs(args) {
  if (!args || typeof args !== "object") return args;
  const next = { ...args };
  if ("projectPath" in next) {
    next.projectPath = remapProjectPath(next.projectPath);
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
          // Maybe newline-delimited JSON (no Content-Length)
          const nl = buffer.indexOf("\n");
          if (nl === -1) return;
          const line = buffer.subarray(0, nl).toString("utf8").trim();
          buffer = buffer.subarray(nl + 1);
          if (!line) continue;
          if (/^content-length:/i.test(line)) {
            // Incomplete header; put back and wait
            buffer = Buffer.concat([
              Buffer.from(`${line}\n`, "utf8"),
              buffer,
            ]);
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
          // Not framed — treat as ndjson line if possible
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
  npm_config_cache:
    process.env.SOCRATICODE_NPM_CACHE ||
    (process.env.HOME ? `${process.env.HOME}/.npm` : process.env.npm_config_cache),
};

const child = spawn(NPX, NPX_ARGS, {
  stdio: ["pipe", "pipe", "inherit"],
  env: childEnv,
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
  // Pass server → client unchanged (local paths in text are fine).
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

const stop = () => {
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// Keep process alive even if stdin briefly pauses.
process.stdin.resume();
