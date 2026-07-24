#!/usr/bin/env node
// Small ops CLI for the Intake Board (Decision #13, M3 Task 5).
// Usage:
//   ts-node src/cli/intake-ops.ts provision-admin --label <l> --caps <c1,c2>
//   ts-node src/cli/intake-ops.ts retention
//   ts-node src/cli/intake-ops.ts backup
//   ts-node src/cli/intake-ops.ts restore-verify <snapshotPath>
//
// Admin capability matrix (each Central admin route requires ONE capability;
// a credential is granted only the capabilities you list in --caps):
//   intake:read     GET  /api/intake/changes         (Local pulls the change feed)
//   intake:claim    POST /api/intake/intakes/:id/claim (+ renew/release)
//   intake:triage   POST /api/intake/intakes/:id/triage
//   intake:promote  POST /api/intake/intakes/:id/promotion
//   intake:admin    /api/intake/admin/* + the Local /api/local/* admin surface
//
// Two credentials are normally provisioned (Decision #1/#2):
//   1. The Local machine's CENTRAL credential (used by makeCentralClient for
//      refresh/claim/triage-package/promote) needs the full set:
//        --caps intake:read,intake:claim,intake:triage,intake:promote
//      (Provisioning it as only intake:admin makes refresh/claim/triage/promote
//       silently 403 — this is the #1 cross-machine deployment footgun.)
//   2. The owner's Local admin surface credential needs: --caps intake:admin
import { getDb } from '../intake/db';
import { intakeConfig } from '../intake/config';
import { provisionAdminCredential } from '../intake/adminCredentialStore';
import { runRetention } from '../intake/retention';
import { runBackup, verifyRestore } from '../intake/backup';

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      out[key] = value ?? '';
      i += 1;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;

  switch (command) {
    case 'provision-admin': {
      const flags = parseFlags(rest);
      if (!flags.label || !flags.caps) {
        console.error('Usage: intake-ops provision-admin --label <label> --caps <cap1,cap2>');
        console.error('Capabilities: intake:read intake:claim intake:triage intake:promote intake:admin');
        console.error("Local machine's Central credential needs: intake:read,intake:claim,intake:triage,intake:promote");
        console.error("Local admin surface credential needs: intake:admin");
        return 1;
      }
      const db = getDb();
      const capabilities = flags.caps.split(',').map((c) => c.trim()).filter(Boolean);
      const { id, secret } = provisionAdminCredential(db, { label: flags.label, capabilities });
      console.log(`Provisioned admin credential ${id} (label: ${flags.label}, caps: ${capabilities.join(',')})`);
      console.log(`Secret (shown once, store it now): ${secret}`);
      return 0;
    }

    case 'retention': {
      const db = getDb();
      const result = await runRetention(db, { now: Date.now(), attachmentDir: intakeConfig.attachmentDir });
      console.log(
        `Retention: attachmentsDeleted=${result.attachmentsDeleted} sessionsDeleted=${result.sessionsDeleted} errors=${result.errors.length}`
      );
      for (const err of result.errors) console.warn(`  - ${err}`);
      return result.errors.length > 0 ? 1 : 0;
    }

    case 'backup': {
      const db = getDb();
      const result = await runBackup(db, {
        backupTarget: intakeConfig.backupTarget,
        attachmentDir: intakeConfig.attachmentDir,
        now: Date.now(),
      });
      if (result.ok) {
        console.log(`Backup OK: snapshot=${result.snapshotPath} manifest=${result.manifestPath}`);
        return 0;
      }
      console.error(`Backup FAILED: ${result.error}`);
      return 1;
    }

    case 'restore-verify': {
      const snapshotPath = rest[0];
      if (!snapshotPath) {
        console.error('Usage: intake-ops restore-verify <snapshotPath>');
        return 1;
      }
      const result = verifyRestore(snapshotPath);
      console.log(`Restore verify: ok=${result.ok} integrity=${result.integrity} tables=${result.tables.join(',')}`);
      return result.ok ? 0 : 1;
    }

    default:
      console.error('Usage: intake-ops <provision-admin|retention|backup|restore-verify> ...');
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
