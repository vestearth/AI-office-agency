import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../intake/db';
import { runMigrations } from '../intake/migrations';
import { createSession } from '../intake/sessionStore';
import { makeRequireTesterSession } from './testerSession';

function res() {
  return { statusCode: 0, body: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; } };
}

test('rejects missing cookie with 401, accepts valid session', () => {
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO tester(id,label,created_at) VALUES('t1','T',1)").run();
  const s = createSession(db, 't1', Date.now(), 10_000);
  const mw = makeRequireTesterSession(() => db);

  const r1 = res(); let n1 = false;
  mw({ cookies: {} } as any, r1 as any, () => { n1 = true; });
  assert.equal(r1.statusCode, 401);
  assert.equal(n1, false);

  const req2: any = { cookies: { intake_sid: s.sessionId } };
  const r2 = res(); let n2 = false;
  mw(req2, r2 as any, () => { n2 = true; });
  assert.equal(n2, true);
  assert.equal(req2.tester.id, 't1');
});
