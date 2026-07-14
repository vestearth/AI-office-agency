#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { resolveLocalProjectRoot } = require("./socraticode-paths");

const DEFAULT_ROOT =
  process.env.SOCRATICODE_GRAPH_ROOT || resolveLocalProjectRoot();
const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", "vendor", ".idea", ".vscode"]);

function normalize(p) {
  return p.replace(/\\/g, "/");
}

function rel(root, absPath) {
  return normalize(path.relative(root, absPath));
}

function walkFiles(root, current = "") {
  const absDir = path.resolve(root, current);
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relative = current ? path.join(current, entry.name) : entry.name;
    const normalized = normalize(relative);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      files.push(...walkFiles(root, relative));
      continue;
    }
    files.push(normalized);
  }

  return files;
}

function parseGoModModulePath(goModAbs) {
  const text = fs.readFileSync(goModAbs, "utf8");
  const match = text.match(/^\s*module\s+(.+)$/m);
  if (!match) {
    return null;
  }
  return match[1].trim();
}

function collectModules(root) {
  const goModFiles = walkFiles(root).filter((file) => path.basename(file) === "go.mod");

  return goModFiles
    .map((relativeGoMod) => {
      const goModAbs = path.resolve(root, relativeGoMod);
      const modulePath = parseGoModModulePath(goModAbs);
      if (!modulePath) {
        return null;
      }
      return {
        goModAbs,
        modulePath,
        rootAbs: path.dirname(goModAbs),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.rootAbs.length - a.rootAbs.length || b.modulePath.length - a.modulePath.length);
}

function collectGoFiles(root) {
  return walkFiles(root).filter((file) => file.endsWith(".go"));
}

function findModuleForFile(fileAbs, modules) {
  const candidates = modules.filter((module) => {
    return fileAbs === module.rootAbs || fileAbs.startsWith(`${module.rootAbs}${path.sep}`);
  });
  if (candidates.length === 0) {
    return null;
  }
  return candidates[0];
}

function parseGoImports(fileAbs) {
  const text = fs.readFileSync(fileAbs, "utf8");
  const imports = [];
  let inBlock = false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) {
      continue;
    }

    if (!inBlock) {
      const single = trimmed.match(/^import\s+(?:(?:[A-Za-z_][A-Za-z0-9_]*|\.|_)\s+)?\"([^\"]+)\"$/);
      if (single) {
        imports.push(single[1]);
        continue;
      }
      if (/^import\s*\($/.test(trimmed)) {
        inBlock = true;
      }
      continue;
    }

    if (/^\)$/.test(trimmed)) {
      inBlock = false;
      continue;
    }

    const block = trimmed.match(/^(?:(?:[A-Za-z_][A-Za-z0-9_]*|\.|_)\s+)?\"([^\"]+)\"(?:\s*\/\/.*)?$/);
    if (block) {
      imports.push(block[1]);
    }
  }

  return imports;
}

function packagePathForFile(fileAbs, module) {
  const packageDirAbs = path.dirname(fileAbs);
  const relativeDir = path.relative(module.rootAbs, packageDirAbs);
  if (!relativeDir || relativeDir === ".") {
    return module.modulePath;
  }
  return `${module.modulePath}/${normalize(relativeDir)}`;
}

function buildPackageId(module, packagePath) {
  return `${module.rootAbs}::${packagePath}`;
}

function dirHasGoFiles(dirAbs, goDirSet) {
  return goDirSet.has(path.resolve(dirAbs));
}

function resolveImportPath(importPath, currentModule, modules, goDirSet) {
  const candidates = modules.filter((module) => {
    return importPath === module.modulePath || importPath.startsWith(`${module.modulePath}/`);
  });

  if (candidates.length === 0) {
    return null;
  }

  const ordered = [];
  if (currentModule) {
    const sameRoot = candidates.filter((module) => module.rootAbs === currentModule.rootAbs);
    ordered.push(...sameRoot);
  }
  ordered.push(...candidates.filter((module) => !ordered.includes(module)));

  for (const module of ordered) {
    const suffix = importPath === module.modulePath ? "" : importPath.slice(module.modulePath.length + 1);
    const packageRootAbs = suffix ? path.resolve(module.rootAbs, suffix) : module.rootAbs;
    if (!dirHasGoFiles(packageRootAbs, goDirSet)) {
      continue;
    }
    return {
      module,
      packagePath: importPath,
      packageRootAbs,
      packageId: buildPackageId(module, importPath),
    };
  }

  return null;
}

function uniquePush(map, key, value) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  map.get(key).add(value);
}

function canonicalCycleSignature(cyclePackageIds) {
  const core = cyclePackageIds.slice(0, -1);
  if (core.length === 0) {
    return "";
  }

  let best = null;
  for (let offset = 0; offset < core.length; offset += 1) {
    const rotated = core.slice(offset).concat(core.slice(0, offset));
    const signature = rotated.join(" -> ");
    if (best === null || signature < best) {
      best = signature;
    }
  }
  return best;
}

function buildGraph(root) {
  const modules = collectModules(root);
  const goFiles = collectGoFiles(root);
  const goDirSet = new Set(goFiles.map((relativeFile) => path.dirname(path.resolve(root, relativeFile))));

  const fileInfos = [];
  const fileInfoByAbs = new Map();
  const packageFiles = new Map();
  const packageImports = new Map();
  const packageDependents = new Map();
  const fileDependents = new Map();
  const packageInfoById = new Map();
  const allPackages = new Set();
  let externalEdgeCount = 0;

  for (const relativeFile of goFiles) {
    const fileAbs = path.resolve(root, relativeFile);
    const module = findModuleForFile(fileAbs, modules);
    if (!module) {
      continue;
    }

    const packagePath = packagePathForFile(fileAbs, module);
    const packageId = buildPackageId(module, packagePath);
    const imports = parseGoImports(fileAbs);
    const localImports = [];
    const externalImports = [];
    const resolvedTargets = [];

    packageInfoById.set(packageId, packageInfoById.get(packageId) || {
      packageId,
      packagePath,
      moduleRoot: rel(root, module.rootAbs),
      files: [],
    });
    packageInfoById.get(packageId).files.push(rel(root, fileAbs));

    allPackages.add(packageId);

    for (const importPath of imports) {
      const resolved = resolveImportPath(importPath, module, modules, goDirSet);
      if (!resolved) {
        externalImports.push(importPath);
        externalEdgeCount += 1;
        continue;
      }

      localImports.push({
        importPath,
        resolvedPackageId: resolved.packageId,
        resolvedPackagePath: resolved.packagePath,
        resolvedFiles: [],
      });
      resolvedTargets.push(resolved.packageId);
      uniquePush(packageImports, packageId, resolved.packageId);
      uniquePush(packageDependents, resolved.packageId, fileAbs);
    }

    packageFiles.set(packageId, packageFiles.get(packageId) || new Set());
    packageFiles.get(packageId).add(fileAbs);

    fileInfos.push({
      fileAbs,
      fileRel: rel(root, fileAbs),
      module,
      packagePath,
      packageId,
      imports,
      localImports,
      externalImports,
      resolvedTargets,
    });
    fileInfoByAbs.set(fileAbs, fileInfos[fileInfos.length - 1]);
  }

  for (const fileInfo of fileInfos) {
    fileInfo.localImports = fileInfo.localImports.map((entry) => {
      const files = packageFiles.get(entry.resolvedPackageId);
      return {
        ...entry,
        resolvedFiles: files ? Array.from(files).map((absPath) => rel(root, absPath)).sort() : [],
      };
    });
  }

  return {
    root,
    modules,
    goFiles,
    goDirSet,
    fileInfos,
    fileInfoByAbs,
    packageFiles,
    packageImports,
    packageDependents,
    packageInfoById,
    allPackages,
    externalEdgeCount,
  };
}

function buildFileDegreeMap(graph) {
  const packageDependentCounts = new Map();
  for (const [packageId, dependents] of graph.packageDependents.entries()) {
    packageDependentCounts.set(packageId, dependents.size);
  }

  return graph.fileInfos.map((fileInfo) => {
    const dependentCount = packageDependentCounts.get(fileInfo.packageId) || 0;
    const localImportCount = fileInfo.localImports.length;
    return {
      file: fileInfo.fileRel,
      packagePath: fileInfo.packagePath,
      imports: localImportCount,
      dependents: dependentCount,
      degree: localImportCount + dependentCount,
    };
  });
}

function getOrCreatePackageInfo(graph, packageId) {
  if (graph.packageInfoById.has(packageId)) {
    return graph.packageInfoById.get(packageId);
  }
  return null;
}

function resolveProjectRoot(args) {
  const explicit = args.projectPath && args.projectPath.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Invalid projectPath: ${explicit}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`projectPath is not a directory: ${explicit}`);
    }
    return resolved;
  }
  return path.resolve(DEFAULT_ROOT);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function toResultSuccess(method, payload) {
  process.stdout.write(JSON.stringify({
    type: "success",
    method,
    ...payload,
  }));
}

function toResultError(method, error) {
  process.stdout.write(JSON.stringify({
    type: "error",
    method,
    error,
  }));
}

function queryCommand(argv) {
  const args = parseArgs(argv);
  const fileArg = args.file || "";
  if (!fileArg) {
    toResultError("codebase_graph_query", "Missing file parameter");
    return;
  }

  const root = resolveProjectRoot(args);
  const graph = buildGraph(root);
  const targetAbs = path.isAbsolute(fileArg) ? path.resolve(fileArg) : path.resolve(root, fileArg);
  const targetInfo = graph.fileInfoByAbs.get(targetAbs);

  if (!targetInfo) {
    toResultError("codebase_graph_query", `File not found in graph: ${normalize(path.relative(root, targetAbs))}`);
    return;
  }

  const dependentFiles = Array.from(graph.packageDependents.get(targetInfo.packageId) || [])
    .map((absPath) => graph.fileInfoByAbs.get(absPath))
    .filter(Boolean)
    .sort((a, b) => a.fileRel.localeCompare(b.fileRel))
    .map((info) => ({
      file: info.fileRel,
      packagePath: info.packagePath,
      moduleRoot: rel(root, info.module.rootAbs),
    }));

  const packageInfo = getOrCreatePackageInfo(graph, targetInfo.packageId);

  toResultSuccess("codebase_graph_query", {
    message: `Graph query for ${targetInfo.fileRel}`,
    projectPath: root,
    file: targetInfo.fileRel,
    packagePath: targetInfo.packagePath,
    packageFiles: packageInfo ? packageInfo.files : [targetInfo.fileRel],
    imports: targetInfo.localImports.map((entry) => ({
      importPath: entry.importPath,
      resolvedPackagePath: entry.resolvedPackagePath,
      resolvedFiles: entry.resolvedFiles,
      local: true,
    })).concat(targetInfo.externalImports.map((importPath) => ({
      importPath,
      local: false,
    }))),
    dependents: dependentFiles,
    summary: {
      directImports: targetInfo.imports.length,
      localImports: targetInfo.localImports.length,
      localDependents: dependentFiles.length,
    },
  });
}

function statsCommand(argv) {
  const args = parseArgs(argv);
  const root = resolveProjectRoot(args);
  const graph = buildGraph(root);
  const degreeRows = buildFileDegreeMap(graph).sort((a, b) => {
    return b.degree - a.degree || a.file.localeCompare(b.file);
  });
  const orphanRows = degreeRows.filter((row) => row.degree === 0);

  const packageRows = Array.from(graph.packageInfoById.values()).map((packageInfo) => {
    const dependents = Array.from(graph.packageDependents.get(packageInfo.packageId) || []);
    const imports = Array.from(graph.packageImports.get(packageInfo.packageId) || []);
    return {
      packagePath: packageInfo.packagePath,
      moduleRoot: packageInfo.moduleRoot,
      files: packageInfo.files.length,
      imports: imports.length,
      dependents: dependents.length,
      degree: imports.length + dependents.length,
    };
  }).sort((a, b) => b.degree - a.degree || a.packagePath.localeCompare(b.packagePath));

  toResultSuccess("codebase_graph_stats", {
    message: `Graph stats for ${root}`,
    projectPath: root,
    fileCount: graph.goFiles.length,
    packageCount: graph.packageInfoById.size,
    localEdgeCount: Array.from(graph.packageImports.values()).reduce((sum, set) => sum + set.size, 0),
    externalEdgeCount: graph.externalEdgeCount,
    topConnectedFiles: degreeRows.slice(0, 20),
    topConnectedPackages: packageRows.slice(0, 20),
    orphanFiles: orphanRows.slice(0, 50),
  });
}

function circularCommand(argv) {
  const args = parseArgs(argv);
  const root = resolveProjectRoot(args);
  const graph = buildGraph(root);
  const packageGraph = new Map();

  for (const [packageId, targetPackages] of graph.packageImports.entries()) {
    packageGraph.set(packageId, new Set(targetPackages));
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];
  const seen = new Set();

  function dfs(node) {
    color.set(node, GRAY);
    stack.push(node);
    const neighbors = Array.from(packageGraph.get(node) || []);
    for (const neighbor of neighbors) {
      const neighborColor = color.get(neighbor) || WHITE;
      if (neighborColor === WHITE) {
        dfs(neighbor);
        continue;
      }
      if (neighborColor === GRAY) {
        const startIndex = stack.indexOf(neighbor);
        if (startIndex >= 0) {
          const cycle = stack.slice(startIndex).concat(neighbor);
          const signature = canonicalCycleSignature(cycle);
          if (!seen.has(signature)) {
            seen.add(signature);
            cycles.push(cycle.map((packageId) => {
              const info = graph.packageInfoById.get(packageId);
              return {
                packagePath: info ? info.packagePath : packageId,
                moduleRoot: info ? info.moduleRoot : "",
                files: info ? info.files : [],
              };
            }));
          }
        }
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const packageId of graph.packageInfoById.keys()) {
    if ((color.get(packageId) || WHITE) === WHITE) {
      dfs(packageId);
    }
  }

  toResultSuccess("codebase_graph_circular", {
    message: cycles.length > 0 ? `Found ${cycles.length} circular dependency chain(s)` : "No circular dependencies found",
    projectPath: root,
    cycleCount: cycles.length,
    cycles,
  });
}

function help() {
  process.stdout.write(
    [
      "Usage:",
      "  socraticode codebase_graph_query --file <path> [--projectPath <path>]",
      "  socraticode codebase_graph_stats [--projectPath <path>]",
      "  socraticode codebase_graph_circular [--projectPath <path>]",
      "",
      "Environment:",
      "  SOCRATICODE_LOCAL_PROJECT",
    ].join("\n"),
  );
}

function main() {
  const command = process.argv[2] || "help";
  const argv = process.argv.slice(3);

  try {
    if (command === "codebase_graph_query" || command === "query") {
      queryCommand(argv);
      return;
    }
    if (command === "codebase_graph_stats" || command === "stats") {
      statsCommand(argv);
      return;
    }
    if (command === "codebase_graph_circular" || command === "circular") {
      circularCommand(argv);
      return;
    }
    if (command === "--help" || command === "-h" || command === "help") {
      help();
      return;
    }
    toResultError(command, `Unknown graph command: ${command}`);
  } catch (error) {
    toResultError(command, error && error.message ? error.message : String(error));
  }
}

main();
