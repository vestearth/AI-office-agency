#!/usr/bin/env node

const clientArgs = process.argv.slice(2);

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const forwardedClientArgs = clientArgs.map(shellQuote).join(' ');
const clientCommand = ['npm run wait:server && npm run dev:client --', forwardedClientArgs].filter(Boolean).join(' ');
const commands = [
  {
    command: 'npm run dev:server',
    name: 'server',
  },
  {
    command: clientCommand,
    name: 'client',
  },
];

if (process.env.DASHBOARD_DEV_DRY_RUN === '1') {
  process.stdout.write(`${JSON.stringify(commands, null, 2)}\n`);
  process.exit(0);
}

// Lazily required so the dry-run path (and the integration test) does not depend
// on node_modules being installed.
const { concurrently } = require('concurrently');

const { result } = concurrently(commands, {
  prefix: 'name',
  prefixColors: ['blue', 'green'],
});

result.catch(() => {
  process.exit(1);
});
