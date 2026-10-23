import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import { config } from '../config';
import { resolveRunDir } from '../pathSecurity';
import { globalDecisionStore, validateDecisionInput, buildDecisionRecord } from '../services/decisionStore';
import { asObject } from '../services/runScanner';
import { globalReviewModel } from '../services/reviewModel';
import type { DecisionLogResponse } from '@shared/types';

const router = Router();

async function readYaml(filePath: string): Promise<Record<string, any>> {
  try {
    return asObject(yaml.load(await fs.readFile(filePath, 'utf8')));
  } catch {
    return {};
  }
}

// GET decisions for a task.
router.get('/:id', async (req, res) => {
  const dir = resolveRunDir(config.runsDir, req.params.id);
  if (!dir.ok) return res.status(dir.code).json({ error: dir.error });

  const decisions = await globalDecisionStore.read(req.params.id);
  const response: DecisionLogResponse = { taskId: req.params.id, decisions };
  return res.json(response);
});

// POST a new human decision (write-back).
router.post('/:id', async (req, res) => {
  const dir = resolveRunDir(config.runsDir, req.params.id);
  if (!dir.ok) return res.status(dir.code).json({ error: dir.error });

  // The run must exist — don't create decision logs for unknown tasks.
  try {
    await fs.access(dir.runDir);
  } catch {
    return res.status(404).json({ error: 'Run not found' });
  }

  const body = req.body ?? {};
  const valid = validateDecisionInput(body);
  if (!valid.ok) {
    return res.status(400).json({ error: valid.error });
  }

  // Capture the contracted signals the decision was made against (server-side,
  // not client-trusted) for an auditable trail.
  const statusData = await readYaml(path.join(dir.runDir, 'status.yaml'));
  const reviewerData = await readYaml(path.join(dir.runDir, 'reviewer-output.yaml'));

  const record = buildDecisionRecord({
    decision: body.decision,
    actor: body.actor,
    note: body.note,
    statusData,
    reviewerData,
    now: new Date().toISOString(),
  });

  try {
    await globalDecisionStore.append(req.params.id, record);
    globalReviewModel.invalidate();
    return res.status(201).json(record);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to record decision' });
  }
});

export default router;
