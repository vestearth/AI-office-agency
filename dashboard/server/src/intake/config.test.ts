import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { loadIntakeConfig } from './config';

test('loadIntakeConfig derives dbPath under dataDir and applies caps', () => {
  const cfg = loadIntakeConfig({
    INTAKE_DATA_DIR: '/tmp/intake-data',
    INTAKE_ATTACHMENT_DIR: '',
    INTAKE_ATTACHMENT_MAX_BYTES: '5242880',
  });
  assert.equal(cfg.dbPath, path.join('/tmp/intake-data', 'intake.sqlite'));
  // Attachment dir defaults under dataDir when unset.
  assert.equal(cfg.attachmentDir, path.join('/tmp/intake-data', 'attachments'));
  assert.equal(cfg.attachment.maxBytes, 5_242_880);
  assert.ok(cfg.attachment.allowedMime.includes('image/png'));
  assert.ok(!cfg.attachment.allowedMime.includes('application/zip'));
});
