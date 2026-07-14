#!/usr/bin/env node
"use strict";

/**
 * Portable SocratiCode path defaults for this workspace.
 *
 * Resolution order for the local index root:
 *   1. SOCRATICODE_LOCAL_PROJECT
 *   2. SOCRATICODE_FALLBACK_PROJECT
 *   3. SOCRATICODE_ROOT
 *   4. SOCRATICODE_GRAPH_ROOT
 *   5. Parent of ai-dev-office/ (derived from this file's location)
 *
 * Machine-specific absolute paths must not be hardcoded as defaults.
 */

const path = require("path");

function defaultWorkspaceRoot() {
  // ai-dev-office/scripts/socraticode-paths.js → workspace root
  return path.resolve(__dirname, "..", "..");
}

function firstEnvPath(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value != null && String(value).trim() !== "") {
      return path.resolve(String(value).trim());
    }
  }
  return null;
}

function resolveLocalProjectRoot() {
  return (
    firstEnvPath(
      "SOCRATICODE_LOCAL_PROJECT",
      "SOCRATICODE_FALLBACK_PROJECT",
      "SOCRATICODE_ROOT",
      "SOCRATICODE_GRAPH_ROOT"
    ) || defaultWorkspaceRoot()
  );
}

function resolveRemoteCanonicalProject() {
  return (
    process.env.SOCRATICODE_REMOTE_CANONICAL_PROJECT ||
    process.env.SOCRATICODE_PRIMARY_PROJECT ||
    "D:\\llm"
  );
}

function normalizePathKey(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Map remote-canonical / mangled projectPath values onto the local index root.
 * Agents can keep sending d:\\llm; local Docker backend gets the machine root.
 */
function remapProjectPathToLocal(
  value,
  localRoot = resolveLocalProjectRoot(),
  remoteCanonical = resolveRemoteCanonicalProject()
) {
  if (value == null || value === "") return value;
  const raw = String(value);
  const norm = normalizePathKey(raw);
  const remoteNorm = normalizePathKey(remoteCanonical);
  const localNorm = normalizePathKey(localRoot);

  if (norm === remoteNorm || norm === "d:/llm") {
    return localRoot;
  }

  if (norm.startsWith(`${remoteNorm}/`) || norm.startsWith("d:/llm/")) {
    const suffix = raw.replace(/^.*?[\\/]llm[\\/]/i, "").replace(/^[/\\]+/, "");
    return suffix ? path.join(localRoot, suffix.replace(/\\/g, "/")) : localRoot;
  }

  const mangled = `${localNorm}/d:/llm`;
  if (norm === mangled || norm.startsWith(`${mangled}/`)) {
    const suffix = norm.slice(mangled.length).replace(/^\/+/, "");
    return suffix ? path.join(localRoot, suffix) : localRoot;
  }

  return raw;
}

module.exports = {
  defaultWorkspaceRoot,
  resolveLocalProjectRoot,
  resolveRemoteCanonicalProject,
  normalizePathKey,
  remapProjectPathToLocal,
};
