import { Router, raw } from 'express';
import type { DB } from '../../intake/db';
import { getIntake } from '../../intake/intakeStore';
import { makeAttachmentStore } from '../../intake/attachmentStore';
import { ByteBudget } from '../../intake/rateLimiter';
import { intakeConfig } from '../../intake/config';

const ERR_STATUS: Record<string, number> = {
  TOO_LARGE: 413, BAD_TYPE: 415, TOO_MANY: 409, AGGREGATE_EXCEEDED: 409, STORAGE_FULL: 507,
};

export function buildAttachmentsRouter(db: DB): Router {
  const router = Router({ mergeParams: true });
  const store = makeAttachmentStore({
    attachmentDir: intakeConfig.attachmentDir,
    caps: intakeConfig.attachment,
    storageHighWaterBytes: intakeConfig.storageHighWaterBytes,
  });
  const budget = new ByteBudget({
    windowMs: intakeConfig.submission.windowMs,
    maxBytes: intakeConfig.submission.maxUploadBytesPerWindow,
  });

  router.post('/', raw({ type: '*/*', limit: intakeConfig.attachment.maxBytes }), async (req, res) => {
    // Casts avoid depending on (a) the Express.Request augmentation module
    // being part of ts-node's on-demand compile graph for this file in
    // isolation (the augmentation lives in testerSession.ts, Task 7), and
    // (b) mergeParams' inferred params type, which TS narrows to `{}` for a
    // router mounted at a parameterized parent path with its own '/' route.
    const intakeId = (req.params as any).id as string;
    const testerId = (req as any).tester?.id as string;
    const intake = getIntake(db, intakeId);
    if (!intake || intake.tester_id !== testerId) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const buffer = req.body as Buffer;
    const b = budget.charge(testerId, buffer.length, Date.now());
    if (!b.allowed) {
      res.setHeader('Retry-After', Math.ceil(b.retryAfterMs / 1000));
      res.status(429).json({ error: 'Upload byte budget exceeded' });
      return;
    }
    try {
      const row = await store.storeAttachment(db, {
        intakeId, originalName: (req.headers['x-filename'] as string) || 'upload.bin', buffer,
      });
      res.status(201).json({ id: row.id, mime: row.mime, byteSize: row.byte_size });
    } catch (e: any) {
      res.status(ERR_STATUS[e.message] ?? 400).json({ error: e.message });
    }
  });

  return router;
}
