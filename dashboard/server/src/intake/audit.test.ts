import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { recordAudit } from './audit';

test('recordAudit stamps server time and stores detail json', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  recordAudit(db, { kind: 'code_exchange_failed', actorKind: 'system', detail: { reason: 'x' } });
  const row = db.prepare('SELECT * FROM audit_event').get() as any;
  assert.equal(row.kind, 'code_exchange_failed');
  assert.equal(row.actor_kind, 'system');
  assert.ok(row.created_at > 0);
  assert.deepEqual(JSON.parse(row.detail_json), { reason: 'x' });
});
