#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const {
  resolveLocalProjectRoot,
  resolveRemoteCanonicalProject,
  remapProjectPathToLocal,
} = require("./socraticode-paths");

const DEFAULT_COMMAND = process.env.SOCRATICODE_LOCAL_COMMAND || "npx";
const DEFAULT_ARGS = process.env.SOCRATICODE_LOCAL_ARGS
  ? process.env.SOCRATICODE_LOCAL_ARGS.split(" ").filter(Boolean)
  : ["-y", "socraticode"];
const TIMEOUT_MS = Number(process.env.SOCRATICODE_LOCAL_TIMEOUT_MS || 45000);
const LOCAL_ROOT = resolveLocalProjectRoot();
const REMOTE_CANONICAL = resolveRemoteCanonicalProject();

function remapProjectPath(value) {
  return remapProjectPathToLocal(value, LOCAL_ROOT, REMOTE_CANONICAL);
}

function parseValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:\d+|\d+\.\d+)$/.test(String(value))) return Number(value);
  return value;
}

function parseArgs(argv) {
  const positional = [];
  const params = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        params[key] = true;
      } else {
        params[key] = parseValue(next);
        i += 1;
      }
      continue;
    }
    positional.push(token);
  }
  return { tool: positional[0] || "", params };
}

function extractText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    return result.content
      .map((item) => (item && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof result.text === "string") return result.text;
  return JSON.stringify(result);
}

function callLocalMcp(tool, params) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      npm_config_cache:
        process.env.SOCRATICODE_NPM_CACHE
        || (process.env.HOME ? `${process.env.HOME}/.npm` : process.env.npm_config_cache),
    };

    const child = spawn(DEFAULT_COMMAND, DEFAULT_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });

    let stdout = "";
    let stderr = "";
    let pending = stdout;
    let initialized = false;
    let requestId = 1;

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`local SocratiCode MCP timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    child.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (!initialized && message.id === 1) {
          initialized = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          requestId = 2;
          send({
            jsonrpc: "2.0",
            id: requestId,
            method: "tools/call",
            params: { name: tool, arguments: params },
          });
          continue;
        }

        if (message.id === requestId) {
          clearTimeout(timer);
          child.kill("SIGTERM");
          if (message.error) {
            reject(new Error(message.error.message || JSON.stringify(message.error)));
            return;
          }
          resolve(extractText(message.result));
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code && code !== 0 && !initialized) {
        reject(new Error(stderr.trim() || `local SocratiCode MCP exited with code ${code}`));
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "socraticode-tcp-wrapper", version: "1.0.0" },
      },
    });
  });
}

async function main() {
  const { tool, params } = parseArgs(process.argv.slice(2));
  if (!tool) {
    process.stdout.write(JSON.stringify({
      type: "error",
      method: "local_mcp",
      error: "Missing tool name",
    }));
    process.exit(0);
  }

  if (params && Object.prototype.hasOwnProperty.call(params, "projectPath")) {
    params.projectPath = remapProjectPath(params.projectPath);
  }

  try {
    const text = await callLocalMcp(tool, params);
    process.stdout.write(JSON.stringify({
      type: "success",
      method: tool,
      backend: "local-docker",
      text,
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      type: "error",
      method: tool,
      backend: "local-docker",
      error: error.message || String(error),
    }));
  }
}

main();
