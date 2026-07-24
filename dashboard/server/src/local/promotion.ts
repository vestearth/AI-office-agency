import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { projectIntakeForPromotion, assertNoForbiddenFields, PromotedProjection } from './promotionProjection';

// Highest-stakes write path in the dashboard: this is the ONLY code that
// creates directories inside the team-synced `runs/` root. Every step here
// exists to close a specific, previously-flagged risk:
//   - gate re-check before any FS work (Decision #6: never a bypass route)
//   - exclusive mkdir + EEXIST retry (closes the max()+1 allocation race)
//   - redaction + assertNoForbiddenFields before anything touches disk
//   - atomic tmp+fsync+rename writes (same idiom as decisionStore/syncCursor)
//   - validate-then-rollback so a bad run never lingers in runs/

async function nextTaskNumber(runsDir: string, prefix: string): Promise<number> {
  let max = 0;
  try {
    for (const entry of await fs.readdir(runsDir)) {
      const m = entry.match(new RegExp(`^TASK-${prefix}-(\\d+)$`));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {
    /* runsDir may not exist yet */
  }
  return max + 1;
}

let tmpCounter = 0;

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${tmpCounter++}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

function renderTaskMd(taskId: string, p: PromotedProjection): string {
  const lines = [
    `# ${taskId} — ${p.title}`, '',
    `> Promoted from Central Intake ${p.centralIntakeId} (projection ${p.projectionVersion}).`,
    `> Reporter: ${p.reporterRef}`, '',
    '## Summary', p.summary, '',
    '## Product scope', p.productScope ?? '(unassigned — set during PM)', '',
  ];
  // promo.v2 structured fields — only rendered when the intake set them.
  if (p.severity) lines.push('## Severity', p.severity, '');
  if (p.reproSteps) lines.push('## Steps to reproduce', p.reproSteps, '');
  if (p.expected) lines.push('## Expected', p.expected, '');
  if (p.actual) lines.push('## Actual', p.actual, '');
  if (p.environment) lines.push('## Environment', p.environment, '');
  lines.push(
    '## Triage', p.triageSummary ?? '(none)',
    p.riskFlags.length ? `\nRisk flags: ${p.riskFlags.join(', ')}` : '',
    p.duplicateRefs.length ? `Duplicate candidates: ${p.duplicateRefs.join(', ')}` : '',
  );
  return lines.join('\n');
}

function renderStatusYaml(taskId: string, now: number): string {
  // Minimal VALID status.yaml per validate-yaml.rb's status validator:
  // task_id/phase/iteration/current_agent required; state must equal phase
  // when present; current_agent may be null.
  return yaml.dump({
    task_id: taskId, phase: 'pending', state: 'pending', iteration: 0,
    current_agent: null, created_at: new Date(now).toISOString(),
  });
}

export interface PromoteDeps {
  validate?: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  central?: { recordPromotion: (intakeId: string, body: object) => Promise<{ created: boolean; taskId: string }> };
}

export async function promoteIntake(input: {
  intake: { id: string; title: string; body: string; product_hint: string | null; tester_id: string; revision: number };
  triage: { summary?: string; riskFlags?: string[]; duplicateCandidates?: string[] } | null;
  gate: { allowed: boolean; gateOverridden: boolean; reason?: string };
  owner: string; taskPrefix: string; runsDir: string; now: () => number;
} & PromoteDeps): Promise<{ ok: true; taskId: string } | { ok: false; reason: string }> {
  // Gate re-check happens before ANY filesystem work — a blocked gate must
  // leave zero trace (no run dir, nothing) (Decision #6).
  if (!input.gate.allowed) return { ok: false, reason: 'gate_blocked' };

  const projection = projectIntakeForPromotion({ intake: input.intake, triage: input.triage });
  assertNoForbiddenFields(projection); // defense-in-depth before writing team-synced runs/

  // Collision-safe allocation: exclusive mkdir, retry on EEXIST. This is the
  // actual collision guard (not a check-then-create race) — max() only picks
  // a starting candidate, mkdir's atomicity is what prevents the collision.
  let taskId = '';
  let runDir = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    const n = await nextTaskNumber(input.runsDir, input.taskPrefix);
    taskId = `TASK-${input.taskPrefix}-${String(n).padStart(3, '0')}`;
    runDir = path.join(input.runsDir, taskId);
    try {
      await fs.mkdir(runDir, { recursive: false }); // NOT recursive → throws EEXIST on a race
      break;
    } catch (e: any) {
      if (e.code === 'EEXIST') { taskId = ''; continue; }
      throw e;
    }
  }
  if (!taskId) return { ok: false, reason: 'id_allocation_failed' };

  try {
    await atomicWrite(path.join(runDir, 'task.md'), renderTaskMd(taskId, projection));
    await atomicWrite(path.join(runDir, 'status.yaml'), renderStatusYaml(taskId, input.now()));

    const validate = input.validate ?? (async () => ({ ok: true }));
    const v = await validate(taskId);
    if (!v.ok) {
      await fs.rm(runDir, { recursive: true, force: true }); // roll back — no partial artifacts left behind
      return { ok: false, reason: 'validation_failed' };
    }

    if (input.central) {
      const result = await input.central.recordPromotion(input.intake.id, {
        taskId, projectionVersion: projection.projectionVersion,
        gateOverridden: input.gate.gateOverridden, projection,
      });
      if (!result.created) {
        // Central already had a promotion row for this intake (retried/
        // racing promote) — the run dir just created here is normally an
        // orphan with no promotion row referencing it, and should be rolled
        // back in favor of the ORIGINAL taskId the caller converges on.
        //
        // EXCEPTION: if Central committed the promotion on a prior attempt
        // but the response was lost before this function saw it, the outer
        // catch on that attempt already rolled back ITS run dir — so the
        // canonical taskId's directory is gone even though Central thinks
        // it's promoted. This retry then re-allocated and re-created that
        // SAME canonical id (result.taskId === taskId). In that case the
        // dir we just created IS the canonical one being re-materialized,
        // not an orphan — removing it would silently delete the task.
        if (result.taskId !== taskId) {
          await fs.rm(runDir, { recursive: true, force: true });
        }
        return { ok: true, taskId: result.taskId };
      }
    }
    // NEVER invoke run-agent.sh, dispatch, or PM here — promotion only
    // creates the run directory; a human/PM starts work on it separately.
    return { ok: true, taskId };
  } catch (e) {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: 'promotion_error' };
  }
}
