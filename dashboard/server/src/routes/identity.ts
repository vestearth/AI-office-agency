import { Router } from 'express';
import { config } from '../config';
import {
  prefixCandidatesFromName,
  readEffectivePrefix,
  readTeamRegistry,
  registerPrefix,
  writeLocalPrefix,
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

// POST the dashboard display name. Behavior:
// - prefix already configured: claim it in office.team.yaml if unclaimed;
//   report a conflict if someone else owns it (config is never changed).
// - no prefix yet: derive one that dodges registry collisions, write it to
//   office.config.local.yaml, and register it in office.team.yaml.
router.post('/', async (req, res) => {
  const actor = req.body?.actor;
  if (typeof actor !== 'string' || !actor.trim()) {
    return res.status(400).json({ error: 'actor must be a non-empty string' });
  }
  if (actor.length > ACTOR_MAX_LEN) {
    return res.status(400).json({ error: `actor exceeds ${ACTOR_MAX_LEN} characters` });
  }
  const name = actor.trim();

  const effective = await readEffectivePrefix(config.aiOfficeRoot);
  const registry = await readTeamRegistry(config.aiOfficeRoot);

  if (effective.taskPrefix) {
    const prefix = effective.taskPrefix;
    const owner = registry[prefix];
    if (owner !== undefined && owner !== name) {
      // Explicitly configured but owned by someone else — surface, don't touch.
      return res.json({
        taskPrefix: prefix,
        source: effective.source,
        owner,
        conflict: { prefix, owner },
        written: false,
      });
    }
    try {
      const result = await registerPrefix(config.aiOfficeRoot, prefix, name);
      return res.json({
        taskPrefix: prefix,
        source: effective.source,
        owner: name,
        conflict: null,
        written: false,
        registryUpdated: result === 'registered',
      });
    } catch {
      return res.status(500).json({ error: 'Failed to update office.team.yaml' });
    }
  }

  const candidate = prefixCandidatesFromName(name).find(
    (c) => registry[c] === undefined || registry[c] === name,
  );
  if (!candidate) {
    return res.status(422).json({
      error:
        'Could not derive a free task prefix from this name (needs latin letters; ' +
        'all candidates taken). Set office.task_prefix in office.config.local.yaml manually ' +
        'and register it in office.team.yaml.',
    });
  }

  try {
    await writeLocalPrefix(config.aiOfficeRoot, candidate);
    const result = await registerPrefix(config.aiOfficeRoot, candidate, name);
    return res.status(201).json({
      taskPrefix: candidate,
      source: 'local-config',
      owner: name,
      conflict: null,
      written: true,
      registryUpdated: result === 'registered',
    });
  } catch {
    return res.status(500).json({ error: 'Failed to write prefix configuration' });
  }
});

export default router;
