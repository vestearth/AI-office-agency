import { Router, json, type Express } from 'express';
import type { DB } from '../../intake/db';
import { getDb } from '../../intake/db';
import { intakeConfig } from '../../intake/config';
import { makeCentralClient } from '../../local/centralClient';
import { readCursor, writeCursor } from '../../local/syncCursor';
import { resolveAllowedRepos, classifyScope, captureProvenance } from '../../local/repoProvenance';
import { buildTriagePackage } from '../../local/triagePackage';
import { checkPromotionGate } from '../../local/triageGate';
import { promoteIntake } from '../../local/promotion';
import { createAuthMiddleware } from '../../middleware/auth';

// Deps are injectable so the integration test can stub Central + fs + validate,
// and so a real deployment's runsDir/cursorPath always come from intakeConfig.
export interface LocalDeps {
  db?: DB;
  client?: ReturnType<typeof makeCentralClient>;
  cursorPath?: string;
  runsDir?: string;
  taskPrefix?: string;
  validate?: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  now?: () => number;
}

export function buildLocalRouter(adminToken: string | undefined, deps: LocalDeps = {}): Router {
  const db = deps.db ?? getDb();
  const client = deps.client ?? makeCentralClient({ baseUrl: intakeConfig.centralBaseUrl, adminToken: adminToken ?? '' });
  const cursorPath = deps.cursorPath ?? intakeConfig.syncCursorPath;
  const runsDir = deps.runsDir ?? intakeConfig.runsDir;
  const now = deps.now ?? (() => Date.now());

  const router = Router();
  // Local never opens Central SQLite directly (Decision #1) — every route
  // below reaches Central only through `client`, an injected makeCentralClient.
  router.use(createAuthMiddleware(adminToken), json({ limit: '512kb' }));

  // Read-only (Decision #14): pulls newer-than-cursor changes and advances
  // the durable cursor file; never mutates Central state.
  router.post('/refresh', async (_req, res) => {
    const cursor = await readCursor(cursorPath);
    const { changes, nextCursor } = await client.getChanges(cursor);
    if (nextCursor > cursor) await writeCursor(cursorPath, nextCursor);
    res.json({ changes, cursor: nextCursor });
  });

  router.post('/intakes/:id/claim', async (req, res) =>
    res.json(await client.claim(req.params.id, String(req.body?.owner ?? ''), Number(req.body?.expectedRevision))));

  router.post('/intakes/:id/renew', async (req, res) =>
    res.json(await client.renewClaim(req.params.id, String(req.body?.claimId ?? ''), String(req.body?.owner ?? ''))));

  router.post('/intakes/:id/release', async (req, res) =>
    res.json(await client.releaseClaim(req.params.id, String(req.body?.claimId ?? ''), String(req.body?.owner ?? ''))));

  router.post('/intakes/:id/triage-package', async (req, res) => {
    const intake = req.body?.intake; // owner supplies the claimed intake snapshot from a prior refresh/detail
    const scope = classifyScope(intake, resolveAllowedRepos(intakeConfig.intakeRepoAllowlist));
    if (scope.needsScopeReview) {
      // Ambiguous/empty scope stops here — never call buildTriagePackage,
      // which throws on an empty repo set (Decision #5).
      res.json({ needsScopeReview: true });
      return;
    }
    const provenance = scope.repos
      .map((name) => intakeConfig.intakeRepoAllowlist.find((r) => r.name === name))
      .filter(Boolean)
      .map((r: any) => captureProvenance(r.path, undefined, now, intakeConfig.localMachineId));
    const pkg = buildTriagePackage({ intake, repos: scope.repos, provenance });
    res.json(pkg);
  });

  router.post('/intakes/:id/triage-result', async (req, res) =>
    res.json(await client.importTriage(req.params.id, req.body)));

  router.post('/intakes/:id/promote', async (req, res) => {
    const { intake, triage, override } = req.body ?? {};
    const gate = checkPromotionGate({ intakeState: intake?.state, latestTriage: triage ?? null, override });
    const result = await promoteIntake({
      intake, triage: triage ?? null, gate, owner: String(req.body?.owner ?? ''),
      taskPrefix: deps.taskPrefix ?? String(req.body?.taskPrefix ?? '').trim(),
      runsDir, now, validate: deps.validate,
      central: { recordPromotion: (id, body) => client.recordPromotion(id, body).then(() => undefined) },
    });
    res.status(result.ok ? 201 : 409).json(result);
  });

  return router;
}

export function mountLocalRoutes(app: Express, adminToken: string | undefined, deps: LocalDeps = {}): void {
  app.use('/api/local', buildLocalRouter(adminToken, deps));
}
