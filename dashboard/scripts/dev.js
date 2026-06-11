#!/usr/bin/env node

const { spawn } = require('node:child_process');
const path = require('node:path');

const dashboardRoot = path.resolve(__dirname, '..');
const activeChildren = new Set();

function spawnCommand(command, args, cwd) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')], {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
  }

  return spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
}

function run(name, cwd, command, args) {
  let child;

  try {
    child = spawnCommand(command, args, cwd);
  } catch (error) {
    console.error(`[${name}] ${error.message}`);
    shutdown(1);
    return null;
  }

  activeChildren.add(child);

  child.on('error', (error) => {
    console.error(`[${name}] ${error.message}`);
    shutdown(1);
  });

  child.on('exit', () => {
    activeChildren.delete(child);
  });

  return child;
}

function shutdown(code) {
  for (const child of activeChildren) {
    if (!child.killed) {
      child.kill();
    }
  }

  process.exit(code);
}

function exitCodeFrom(code, signal) {
  return code ?? (signal ? 1 : 0);
}

const server = run('server', path.join(dashboardRoot, 'server'), 'npm', ['run', 'dev']);
const client = run('client', path.join(dashboardRoot, 'client'), 'npm', ['run', 'dev', '--', '--host']);

server.on('exit', (code, signal) => {
  shutdown(exitCodeFrom(code, signal));
});

client.on('exit', (code, signal) => {
  shutdown(exitCodeFrom(code, signal));
});

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
