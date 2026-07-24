import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fromBuffer as fileTypeFromBuffer } from 'file-type';
import type { DB } from './db';
import { randomId, randomToken } from './crypto';
import { recordAudit } from './audit';

export interface AttachmentRow {
  id: string; intake_id: string; stored_name: string; original_name: string;
  mime: string; byte_size: number; content_hash: string; created_at: number;
}
export interface AttachmentCaps {
  maxBytes: number; maxPerIntake: number; maxAggregateBytesPerIntake: number; allowedMime: string[];
}

const TEXT_EXT = new Set(['.txt', '.log']);

function looksLikeUtf8Text(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0)) return false; // NUL byte => binary
  return Buffer.from(sample.toString('utf8'), 'utf8').length > 0;
}

export function makeAttachmentStore(cfg: { attachmentDir: string; caps: AttachmentCaps }) {
  async function resolveMime(originalName: string, buffer: Buffer): Promise<string> {
    const sniffed = await fileTypeFromBuffer(buffer);
    if (sniffed) return sniffed.mime; // magic-byte types (png/jpeg/webp)
    const ext = path.extname(originalName).toLowerCase();
    if (TEXT_EXT.has(ext) && looksLikeUtf8Text(buffer)) return 'text/plain';
    return 'application/octet-stream';
  }

  async function storeAttachment(
    db: DB, input: { intakeId: string; originalName: string; buffer: Buffer }
  ): Promise<AttachmentRow> {
    const { caps } = cfg;
    if (input.buffer.length > caps.maxBytes) throw new Error('TOO_LARGE');

    const existing = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(byte_size),0) AS total FROM attachment WHERE intake_id = ? AND deleted_at IS NULL')
      .get(input.intakeId) as any;
    if (existing.n >= caps.maxPerIntake) throw new Error('TOO_MANY');
    if (existing.total + input.buffer.length > caps.maxAggregateBytesPerIntake) throw new Error('AGGREGATE_EXCEEDED');

    const mime = await resolveMime(input.originalName, input.buffer);
    if (!caps.allowedMime.includes(mime)) throw new Error('BAD_TYPE');

    const storedName = `${randomToken(16)}${path.extname(input.originalName).toLowerCase()}`;
    await fs.mkdir(cfg.attachmentDir, { recursive: true });
    await fs.writeFile(path.join(cfg.attachmentDir, storedName), input.buffer, { flag: 'wx' });

    const id = randomId('ATT');
    const now = Date.now();
    const contentHash = crypto.createHash('sha256').update(input.buffer).digest('hex');
    db.prepare(
      `INSERT INTO attachment(id,intake_id,stored_name,original_name,mime,byte_size,content_hash,created_at)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(id, input.intakeId, storedName, input.originalName, mime, input.buffer.length, contentHash, now);
    recordAudit(db, { kind: 'attachment_stored', actorKind: 'tester', intakeId: input.intakeId, detail: { id, mime } });
    return db.prepare('SELECT * FROM attachment WHERE id = ?').get(id) as AttachmentRow;
  }

  async function deleteAttachment(db: DB, id: string, actorId: string): Promise<void> {
    const row = db.prepare('SELECT * FROM attachment WHERE id = ? AND deleted_at IS NULL').get(id) as AttachmentRow | undefined;
    if (!row) return;
    db.prepare('UPDATE attachment SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
    await fs.rm(path.join(cfg.attachmentDir, row.stored_name), { force: true });
    recordAudit(db, { kind: 'attachment_deleted', actorKind: 'admin', actorId, intakeId: row.intake_id, detail: { id } });
  }

  return { storeAttachment, deleteAttachment };
}
