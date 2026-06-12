import { Router } from 'express';
import { config } from '../config';
import { derivePrefixFromName, readEffectivePrefix, writeLocalPrefix } from '../services/identity';

const router = Router();

const ACTOR_MAX_LEN = 120;

// GET the effective task prefix (what intake on this machine will use).
router.get('/', async (_req, res) => {
  const effective = await readEffectivePrefix(config.aiOfficeRoot);
  return res.json({ ...effective, written: false });
});

// POST the dashboard display name; derives and persists a task prefix when
// none is configured yet. Never overwrites an existing prefix.
router.post('/', async (req, res) => {
  const actor = req.body?.actor;
  if (typeof actor !== 'string' || !actor.trim()) {
    return res.status(400).json({ error: 'actor must be a non-empty string' });
  }
  if (actor.length > ACTOR_MAX_LEN) {
    return res.status(400).json({ error: `actor exceeds ${ACTOR_MAX_LEN} characters` });
  }

  const effective = await readEffectivePrefix(config.aiOfficeRoot);
  if (effective.taskPrefix) {
    return res.json({ ...effective, written: false });
  }

  const derived = derivePrefixFromName(actor);
  if (!derived) {
    return res.status(422).json({
      error:
        'Could not derive a task prefix from this name (needs latin letters). ' +
        'Set office.task_prefix in office.config.local.yaml manually.',
    });
  }

  try {
    await writeLocalPrefix(config.aiOfficeRoot, derived);
  } catch {
    return res.status(500).json({ error: 'Failed to write office.config.local.yaml' });
  }
  return res.status(201).json({ taskPrefix: derived, source: 'local-config', written: true });
});

export default router;
