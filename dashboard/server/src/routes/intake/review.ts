import { Router, json } from 'express';
import type { ReviewBackend } from '../../local/reviewBackend';

const conflict = (reason: string) => reason === 'revision_conflict' || reason === 'already_claimed';

export function buildReviewRouter(backend: ReviewBackend): Router {
  const r = Router();
  r.use(json({ limit: '256kb' }));

  r.get('/intakes', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const includeClosed = req.query.includeClosed === 'true';
    res.json(await backend.list({ state, includeClosed }));
  });

  r.get('/intakes/:id', async (req, res) => {
    const detail = await backend.detail(req.params.id);
    if (!detail) { res.status(404).json({ error: 'not found' }); return; }
    res.json(detail);
  });

  const action = (fn: (id: string, rev: number, body: any) => Promise<any>, okStatus = 200) =>
    async (req: any, res: any) => {
      const rev = Number(req.body?.expectedRevision);
      if (!Number.isInteger(rev)) { res.status(400).json({ error: 'expectedRevision required' }); return; }
      const out = await fn(req.params.id, rev, req.body);
      if (out.ok) { res.status(okStatus).json(out); return; }
      res.status(conflict(out.reason) ? 409 : out.reason === 'not_found' ? 404 : 422).json({ error: out.reason, reason: out.reason, errors: out.errors });
    };

  r.post('/intakes/:id/claim', action((id, rev) => backend.claim(id, rev)));

  r.post('/intakes/:id/release', async (req, res) => {
    const out = await backend.release(req.params.id);
    res.status(out.ok ? 200 : 409).json(out);
  });

  r.post('/intakes/:id/triage-package', async (req, res) => res.json(await backend.triagePackage(req.params.id)));

  r.post('/intakes/:id/triage-result', action((id, rev, body) => backend.recordTriage(id, rev, body.result)));

  r.post('/intakes/:id/promote', action(
    (id, rev, body) => backend.promote(id, rev, { prefix: String(body.prefix ?? '').trim(), overrideReason: body.overrideReason }),
    201
  ));

  return r;
}
