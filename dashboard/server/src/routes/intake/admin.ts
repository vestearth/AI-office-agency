import { Router } from 'express';
import type { DB } from '../../intake/db';
import { issueAccessCode, revokeAccessCode } from '../../intake/accessCodeStore';
import { makeAttachmentStore } from '../../intake/attachmentStore';
import { recordAudit } from '../../intake/audit';
import { intakeConfig } from '../../intake/config';
import { createAuthMiddleware } from '../../middleware/auth';

// M1: admin capability = the existing shared bearer token (adminToken).
export function buildAdminRouter(db: DB, adminToken: string | undefined): Router {
  const router = Router();
  router.use(createAuthMiddleware(adminToken));
  const store = makeAttachmentStore({ attachmentDir: intakeConfig.attachmentDir, caps: intakeConfig.attachment });

  router.post('/codes', (req, res) => {
    const label = (req.body?.label ?? '').toString().trim();
    if (!label) { res.status(400).json({ error: 'label required' }); return; }
    const { testerId, code } = issueAccessCode(db, label);
    // Carry-forward from Task 5: issueAccessCode/revokeAccessCode don't audit
    // themselves (audit belongs at the route layer, where actor context
    // exists). Never put the raw code in the audit detail.
    recordAudit(db, { kind: 'code_issued', actorKind: 'admin', detail: { testerId } });
    res.status(201).json({ testerId, code }); // raw code shown once
  });

  router.delete('/codes/:testerId', (req, res) => {
    revokeAccessCode(db, req.params.testerId);
    recordAudit(db, { kind: 'code_revoked', actorKind: 'admin', detail: { testerId: req.params.testerId } });
    res.status(204).end();
  });

  router.delete('/attachments/:id', async (req, res) => {
    await store.deleteAttachment(db, req.params.id, 'admin');
    res.status(204).end();
  });

  return router;
}
