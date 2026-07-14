#!/usr/bin/env node
/**
 * Persistent SocratiCode local-backend watch daemon.
 * Managed by LaunchAgent co.sparqlab.socraticode-local-watch (optional).
 *
 * Starts local `socraticode` (Docker: Qdrant + Ollama) and enables the file
 * watcher for the workspace root so the vector index stays fresh.
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
  npm_config_cache:
    process.env.SOCRATICODE_NPM_CACHE ||
    (process.env.HOME ? path.join(process.env.HOME, ".npm") : process.env.npm_config_cache),
};

const srv = spawn(NPX, NPX_ARGS, {
  stdio: ["pipe", "pipe", "inherit"],
  env: childEnv,
  shell: false,
});

const send = (o) => {
  try {
    srv.stdin.write(`${JSON.stringify(o)}\n`);
  } catch {
    // ignore
  }
};

srv.stdout.on("data", () => {});

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

setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "codebase_watch",
      arguments: { projectPath: PROJECT, action: "start" },
    },
  });
  console.error(`[watch-daemon] watch start requested for ${PROJECT}`);
}, 2500);

srv.on("exit", (code) => {
  console.error(
    `[watch-daemon] socraticode server exited (code=${code}); exiting for launchd restart`
  );
  process.exit(code ?? 1);
});

const stop = () => {
  try {
    srv.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
