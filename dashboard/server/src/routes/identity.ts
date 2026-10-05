import { Router } from 'express';
import { config } from '../config';
import {
  IdentitySyncError,
  readEffectivePrefix,
  readTeamRegistry,
  syncDashboardIdentity,
} from '../services/identity';

const router = Router();

const ACTOR_MAX_LEN = 120;

// GET the effective task prefix (what intake on this machine will use) plus
// its registry owner, so the client can flag a prefix owned by someone else.
router.get('/', async (_req, res) => {
  const effective = await readEffectivePrefix(config.aiOfficeRoot);
  const registry = await readTeamRegistry(config.aiOfficeRoot);
  const owner = effective.taskPrefix ? registry[effective.taskPrefix] ?? null : null;
  return res.json({ ...effective, owner, conflict: null, written: false });
});

// POST the dashboard display name and delegate prefix reconciliation to the
// shared identity service. That service resolves the actor's prefix, updates
// office.config.local.yaml when needed, records the shared registry claim, and
// surfaces conflict / no-candidate cases as typed sync errors.
router.post('/', async (req, res) => {
  const actor = req.body?.actor;
  if (typeof actor !== 'string' || !actor.trim()) {
    return res.status(400).json({ error: 'actor must be a non-empty string' });
  }
  if (actor.length > ACTOR_MAX_LEN) {
    return res.status(400).json({ error: `actor exceeds ${ACTOR_MAX_LEN} characters` });
  }
  const name = actor.trim();

  try {
    const result = await syncDashboardIdentity(config.aiOfficeRoot, name);
    return res.status(result.registryUpdated ? 201 : 200).json(result);
  } catch (error) {
    if (error instanceof IdentitySyncError) {
      if (error.code === 'no-prefix-candidate') {
        return res.status(422).json({ error: error.message });
      }
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to reconcile task prefix identity' });
  }
});

export default router;
