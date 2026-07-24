import type { DB } from '../intake/db';
import { listReviewIntakes, getReviewDetail, type ReviewIntakeSummary, type ReviewIntakeDetail } from '../intake/reviewStore';
import { getIntake } from '../intake/intakeStore';
import { claimIntake, releaseClaim, getActiveClaim } from '../intake/claimStore';
import { classifyScope, resolveAllowedRepos, captureProvenance } from './repoProvenance';
import { buildTriagePackage } from './triagePackage';
import { validateTriageResult } from '../intake/triageSchema';
import { importTriageResult, getLatestTriage } from '../intake/triageStore';
import { checkPromotionGate } from './triageGate';
import { promoteIntake } from './promotion';
import { recordPromotion } from '../intake/promotionRecordStore';
import { intakeConfig } from '../intake/config';
import { readEffectivePrefix, readTeamRegistry } from '../services/identity';

type Result<T> = ({ ok: true } & T) | ({ ok: false; reason: string; errors?: string[] });

export interface ReviewBackend {
  list(opts: { state?: string; includeClosed?: boolean }): Promise<{ intakes: ReviewIntakeSummary[]; counts: Record<string, number> }>;
  detail(id: string): Promise<ReviewIntakeDetail | null>;
  claim(id: string, expectedRevision: number): Promise<Result<{ claim: { owner: string; expiresAt: number } }>>;
  release(id: string): Promise<Result<{}>>;
  triagePackage(id: string): Promise<Result<{ needsScopeReview?: boolean; contextHash?: string; repos?: string[]; manifest?: object }>>;
  recordTriage(id: string, expectedRevision: number, raw: unknown): Promise<Result<{ state: string }>>;
  promote(id: string, expectedRevision: number, opts: { prefix: string; overrideReason?: string }): Promise<Result<{ taskId: string }>>;
}

export async function resolveOwner(officeRoot: string, localMachineId: string): Promise<string> {
  const eff = await readEffectivePrefix(officeRoot);
  const registry = eff.taskPrefix ? await readTeamRegistry(officeRoot) : {};
  return (eff.taskPrefix && registry[eff.taskPrefix]) || localMachineId;
}

export function makeInProcessReviewBackend(
  db: DB,
  deps: { runsDir: string; officeRoot: string; now?: () => number; validate?: (taskId: string) => Promise<{ ok: boolean }> }
): ReviewBackend {
  const now = deps.now ?? (() => Date.now());
  const owner = () => resolveOwner(deps.officeRoot, intakeConfig.localMachineId);

  return {
    async list(opts) { return listReviewIntakes(db, opts, now()); },
    async detail(id) { return getReviewDetail(db, id, now()); },

    async claim(id, expectedRevision) {
      const r = claimIntake(db, { intakeId: id, owner: await owner(), expectedRevision, now: now(), ttlMs: intakeConfig.claimTtlMs });
      return r.ok ? { ok: true, claim: { owner: r.claim.owner, expiresAt: r.claim.expires_at } } : { ok: false, reason: r.reason };
    },

    async release(id) {
      const claim = getActiveClaim(db, id, now());
      if (!claim) return { ok: false, reason: 'no_active_claim' };
      const r = releaseClaim(db, { claimId: claim.id, owner: await owner() });
      return r.ok ? { ok: true } : { ok: false, reason: 'release_failed' };
    },

    async triagePackage(id) {
      const intake = getIntake(db, id);
      if (!intake) return { ok: false, reason: 'not_found' };
      const scope = classifyScope(intake, resolveAllowedRepos(intakeConfig.intakeRepoAllowlist));
      if (scope.needsScopeReview) return { ok: true, needsScopeReview: true };
      const provenance = scope.repos
        .map((name) => intakeConfig.intakeRepoAllowlist.find((r) => r.name === name)!)
        .map((r) => captureProvenance(r.path, undefined, now, intakeConfig.localMachineId));
      const pkg = buildTriagePackage({ intake, repos: scope.repos, provenance });
      return { ok: true, contextHash: pkg.contextHash, repos: scope.repos, manifest: pkg.manifest };
    },

    async recordTriage(id, expectedRevision, raw) {
      const validated = validateTriageResult(raw);
      if (!validated.ok) return { ok: false, reason: 'schema_invalid', errors: validated.errors };
      const r = importTriageResult(db, { intakeId: id, expectedRevision, raw, importer: await owner() });
      return r.ok ? { ok: true, state: r.state } : { ok: false, reason: r.reason, errors: r.errors };
    },

    async promote(id, expectedRevision, opts) {
      const intake = getIntake(db, id);
      if (!intake) return { ok: false, reason: 'not_found' };
      if (intake.revision !== expectedRevision) return { ok: false, reason: 'revision_conflict' };
      const latestTriage = getLatestTriage(db, id) as any;
      const gate = checkPromotionGate({ intakeState: intake.state, latestTriage, override: opts.overrideReason ? { reason: opts.overrideReason } : undefined });
      const r = await promoteIntake({
        intake, triage: latestTriage, gate, owner: await owner(), taskPrefix: opts.prefix,
        runsDir: deps.runsDir, now,
        validate: deps.validate ?? (async () => ({ ok: true })),
        central: { recordPromotion: (intakeId, body: any) => Promise.resolve(recordPromotion(db, { intakeId, taskId: body.taskId, projectionVersion: body.projectionVersion, gateOverridden: body.gateOverridden })) },
      });
      return r.ok ? { ok: true, taskId: r.taskId } : { ok: false, reason: r.reason };
    },
  };
}
