# Dashboard-Owned Task Prefix Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Dashboard-selected actor own the prefix used for every newly created ordinary task, enforce that namespace at PM creation, and stop active hooks/prompts from recommending plain `TASK-NNN`.

**Architecture:** Move Dashboard identity selection into one tested service operation that reuses an actor's registry claim, claims an explicitly configured unowned prefix, or derives a collision-free prefix before atomically updating local config. Add a runner gate immediately before a missing PM task directory is created, while leaving all existing task directories backward compatible. Align active operator guidance and add a focused regression script so task-creation hooks cannot drift back to plain IDs.

**Tech Stack:** TypeScript, Node.js test runner, Express, Ruby embedded in Bash, YAML via `js-yaml`/Ruby `YAML`, shell integration tests.

---

## File Map

- Modify `dashboard/server/src/services/identity.ts`: strict YAML reads plus actor-to-prefix reconciliation and persistence.
- Modify `dashboard/server/src/services/identity.test.ts`: focused identity-switching, collision, manual-prefix, and failure tests.
- Modify `dashboard/server/src/routes/identity.ts`: delegate POST reconciliation to the service and map typed errors to HTTP responses.
- Modify `run-agent.sh`: enforce the effective registered namespace only before creating a missing PM task directory.
- Modify `tests/integration/team-prefix-registry.sh`: cover valid/invalid direct PM creation and existing legacy runs.
- Create `tests/integration/task-id-guidance-policy.sh`: prevent active PM hooks/prompts from recommending plain IDs.
- Modify `agents/pm.md`, `SKILL.md`, `QUICKSTART.md`, `docs/getting-started.md`, `docs/skills/office-intake.md`, and `profiles/games-labs.md`: make intake-returned `<TASK_ID>` the new-task contract.
- Modify `templates/cursor/agents/ai-dev-office-pm.md` and `templates/cursor/rules/ai-dev-office.mdc`: fix portable Cursor trigger/rule guidance.
- Modify workspace-installed `.cursor/agents/ai-dev-office-pm.md`, `.cursor/rules/ai-dev-office.mdc`, root `AGENTS.md`, and `.github/copilot-instructions.md`: align active workspace hooks with the portable source.

### Task 1: Reconcile Dashboard Actor to the Correct Prefix

**Files:**
- Modify: `dashboard/server/src/services/identity.test.ts`
- Modify: `dashboard/server/src/services/identity.ts`

- [ ] **Step 1: Write failing actor-switch and prefix-selection tests**

Add imports for `syncDashboardIdentity` and `IdentitySyncError`, then add these tests to `dashboard/server/src/services/identity.test.ts`:

```typescript
test('syncDashboardIdentity switches actors and reuses their registered prefixes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  await fs.writeFile(path.join(root, 'office.team.yaml'), 'prefixes: {}\n');

  const earth = await syncDashboardIdentity(root, 'Earth');
  assert.equal(earth.taskPrefix, 'EAR');
  assert.equal(earth.selection, 'derived');

  const bob = await syncDashboardIdentity(root, 'Bob');
  assert.equal(bob.taskPrefix, 'BOB');
  assert.equal(bob.switched, true);

  const earthAgain = await syncDashboardIdentity(root, 'Earth');
  assert.equal(earthAgain.taskPrefix, 'EAR');
  assert.equal(earthAgain.selection, 'registered-owner');

  assert.deepEqual(await readTeamRegistry(root), { EAR: 'Earth', BOB: 'Bob' });
  assert.deepEqual(await readEffectivePrefix(root), {
    taskPrefix: 'EAR',
    source: 'local-config',
  });
});

test('syncDashboardIdentity preserves an explicitly configured unowned prefix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  await fs.writeFile(path.join(root, 'office.team.yaml'), 'prefixes: {}\n');
  await fs.writeFile(
    path.join(root, 'office.config.local.yaml'),
    yaml.dump({ office: { task_prefix: 'TEAM' }, loop_guard: { max_iterations: 3 } }),
  );

  const result = await syncDashboardIdentity(root, 'Alice');
  assert.equal(result.taskPrefix, 'TEAM');
  assert.equal(result.selection, 'configured-unowned');
  assert.deepEqual(await readTeamRegistry(root), { TEAM: 'Alice' });
});

test('syncDashboardIdentity avoids collisions without stealing a claim', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  await fs.writeFile(path.join(root, 'office.team.yaml'), 'prefixes:\n  EAR: "Erin"\n');

  const result = await syncDashboardIdentity(root, 'Earth');
  assert.equal(result.taskPrefix, 'EAR2');
  assert.deepEqual(await readTeamRegistry(root), { EAR: 'Erin', EAR2: 'Earth' });
});

test('syncDashboardIdentity fails closed without changing local config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  const localPath = path.join(root, 'office.config.local.yaml');
  await fs.writeFile(localPath, yaml.dump({ office: { task_prefix: 'EAR' } }));
  await fs.writeFile(path.join(root, 'office.team.yaml'), 'prefixes:\n\tEAR: Earth\n');
  const before = await fs.readFile(localPath, 'utf8');

  await assert.rejects(() => syncDashboardIdentity(root, 'Bob'));
  assert.equal(await fs.readFile(localPath, 'utf8'), before);
});

test('syncDashboardIdentity rejects a name with no usable prefix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-'));
  await fs.writeFile(path.join(root, 'office.team.yaml'), 'prefixes:\n  EAR: Earth\n');
  await fs.writeFile(
    path.join(root, 'office.config.local.yaml'),
    yaml.dump({ office: { task_prefix: 'EAR' } }),
  );

  await assert.rejects(
    () => syncDashboardIdentity(root, 'เอิร์ธ'),
    (error: unknown) => error instanceof IdentitySyncError && error.code === 'no-prefix-candidate',
  );
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd dashboard/server
node --require ts-node/register --test \
  --test-name-pattern='syncDashboardIdentity' \
  "src/**/*.test.ts"
```

Expected: FAIL because `syncDashboardIdentity` and `IdentitySyncError` are not exported.

- [ ] **Step 3: Make YAML parsing fail closed**

Replace the broad catch in `readYamlFile` with missing-file-only fallback:

```typescript
async function readYamlFile(filePath: string): Promise<Record<string, any>> {
  try {
    return asObject(yaml.load(await fs.readFile(filePath, 'utf8')));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}
```

This ensures malformed local config or `office.team.yaml` is never interpreted as an empty registry.

- [ ] **Step 4: Add the minimal reconciliation operation**

Add these types and function after `RegisterResult`/`registerPrefix` in `identity.ts`:

```typescript
export type IdentitySelection = 'registered-owner' | 'configured-unowned' | 'derived';

export interface IdentitySyncResult {
  taskPrefix: string;
  source: 'local-config';
  owner: string;
  conflict: null;
  written: boolean;
  registryUpdated: boolean;
  switched: boolean;
  selection: IdentitySelection;
}

export class IdentitySyncError extends Error {
  constructor(
    public readonly code: 'no-prefix-candidate' | 'prefix-conflict',
    message: string,
  ) {
    super(message);
    this.name = 'IdentitySyncError';
  }
}

export async function syncDashboardIdentity(
  officeRoot: string,
  actor: string,
): Promise<IdentitySyncResult> {
  const name = actor.trim();
  const effective = await readEffectivePrefix(officeRoot);
  const registry = await readTeamRegistry(officeRoot);
  const registeredOwnerPrefix = Object.keys(registry)
    .sort()
    .find((prefix) => registry[prefix] === name);

  let taskPrefix: string | undefined;
  let selection: IdentitySelection;

  if (registeredOwnerPrefix) {
    taskPrefix = registeredOwnerPrefix;
    selection = 'registered-owner';
  } else if (effective.taskPrefix && registry[effective.taskPrefix] === undefined) {
    taskPrefix = effective.taskPrefix;
    selection = 'configured-unowned';
  } else {
    taskPrefix = prefixCandidatesFromName(name).find(
      (candidate) => registry[candidate] === undefined || registry[candidate] === name,
    );
    selection = 'derived';
  }

  if (!taskPrefix) {
    throw new IdentitySyncError(
      'no-prefix-candidate',
      'Could not derive a free task prefix from this name; set a manual prefix.',
    );
  }

  const registration = await registerPrefix(officeRoot, taskPrefix, name);
  if (registration === 'conflict') {
    throw new IdentitySyncError(
      'prefix-conflict',
      `Prefix ${taskPrefix} is registered to another actor.`,
    );
  }

  const written = effective.taskPrefix !== taskPrefix || effective.source !== 'local-config';
  if (written) await writeLocalPrefix(officeRoot, taskPrefix);

  return {
    taskPrefix,
    source: 'local-config',
    owner: name,
    conflict: null,
    written,
    registryUpdated: registration === 'registered',
    switched: effective.taskPrefix !== null && effective.taskPrefix !== taskPrefix,
    selection,
  };
}
```

Update the `writeLocalPrefix` comment to state that Dashboard identity reconciliation may intentionally replace the per-machine prefix while preserving unrelated keys.

- [ ] **Step 5: Run identity tests and TypeScript build**

Run:

```bash
cd dashboard/server
node --require ts-node/register --test \
  --test-name-pattern='syncDashboardIdentity|derivePrefixFromName|readEffectivePrefix|readTeamRegistry|registerPrefix|writeLocalPrefix' \
  "src/**/*.test.ts"
npm run build
```

Expected: all matching tests PASS and `tsc` exits 0.

- [ ] **Step 6: Commit the identity service change**

```bash
git add dashboard/server/src/services/identity.ts dashboard/server/src/services/identity.test.ts
git commit -m "feat(dashboard): bind task prefixes to selected actor"
```

### Task 2: Route Dashboard Identity Saves Through Reconciliation

**Files:**
- Modify: `dashboard/server/src/routes/identity.ts`

- [ ] **Step 1: Replace route-level prefix selection with the tested service**

Change the imports to include `IdentitySyncError` and `syncDashboardIdentity`; retain `readEffectivePrefix` and `readTeamRegistry` for GET:

```typescript
import {
  IdentitySyncError,
  readEffectivePrefix,
  readTeamRegistry,
  syncDashboardIdentity,
} from '../services/identity';
```

Replace the POST body after actor validation with:

```typescript
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
```

Delete the obsolete route-local configured-prefix/conflict/derive branches.

- [ ] **Step 2: Run the complete Dashboard server suite**

Run:

```bash
cd dashboard/server
npm test
npm run build
```

Expected: all server tests PASS and build exits 0.

- [ ] **Step 3: Commit the route wiring**

```bash
git add dashboard/server/src/routes/identity.ts
git commit -m "refactor(dashboard): centralize identity prefix reconciliation"
```

### Task 3: Reject New PM Tasks Outside the Active Namespace

**Files:**
- Modify: `tests/integration/team-prefix-registry.sh`
- Modify: `run-agent.sh`

- [ ] **Step 1: Add failing direct-PM creation scenarios**

Append scenarios to `team-prefix-registry.sh` after the existing intake cases:

```bash
echo "== Scenario 9: new PM tasks must use the active registered namespace =="
printf 'prefixes:\n  EA: Earth\n  BOB: Bob\n' > "$OFFICE/office.team.yaml"
rm -f "$OFFICE/office.config.local.yaml"
if out="$(cd "$OFFICE" && ./run-agent.sh TASK-EA-001 pm cursor 2>&1)"; then
  fail "new PM task without Dashboard identity must be rejected: $out"
fi
grep -q "set your Dashboard name" <<<"$out" \
  || fail "missing Dashboard identity guidance: $out"
[[ ! -d "$OFFICE/runs/TASK-EA-001" ]] || fail "unset identity must not create a task"

printf 'office:\n  task_prefix: EA\n' > "$OFFICE/office.config.local.yaml"

if out="$(cd "$OFFICE" && ./run-agent.sh TASK-001 pm cursor 2>&1)"; then
  fail "new unprefixed PM task must be rejected: $out"
fi
grep -q "must use active namespace TASK-EA-NNN" <<<"$out" \
  || fail "missing active namespace guidance: $out"
[[ ! -d "$OFFICE/runs/TASK-001" ]] || fail "rejected task directory must not be created"

if out="$(cd "$OFFICE" && ./run-agent.sh TASK-BOB-001 pm cursor 2>&1)"; then
  fail "another user's namespace must be rejected: $out"
fi
[[ ! -d "$OFFICE/runs/TASK-BOB-001" ]] || fail "other-user task directory must not be created"

out="$(cd "$OFFICE" && ./run-agent.sh TASK-EA-001 pm cursor 2>&1 || true)"
grep -q "Creating task directory" <<<"$out" || fail "active namespace should reach PM creation: $out"
[[ -d "$OFFICE/runs/TASK-EA-001" ]] || fail "valid namespaced task directory should be created"

echo "== Scenario 10: existing legacy and special task directories stay runnable =="
mkdir -p "$OFFICE/runs/TASK-009" "$OFFICE/runs/TASK-PKG-001"
out="$(cd "$OFFICE" && ./run-agent.sh TASK-009 pm cursor 2>&1 || true)"
! grep -q "must use active namespace" <<<"$out" || fail "existing legacy task was blocked: $out"
out="$(cd "$OFFICE" && ./run-agent.sh TASK-PKG-001 pm cursor 2>&1 || true)"
! grep -q "must use active namespace" <<<"$out" || fail "existing package task was blocked: $out"
echo "[OK] PM creation gate preserves existing tasks"
```

- [ ] **Step 2: Run the integration test and verify it fails**

Run:

```bash
bash tests/integration/team-prefix-registry.sh
```

Expected: FAIL because `TASK-001` is still created directly.

- [ ] **Step 3: Add a namespace gate before PM creates a directory**

Add a shell helper near `show_intake_preview` that resolves the effective prefix and validates the registry using fail-closed Ruby parsing:

```bash
enforce_new_task_namespace() {
  local task_id="$1"
  local task_prefix="${OFFICE_TASK_PREFIX:-}"
  if [[ -z "$task_prefix" ]]; then
    task_prefix="$(ruby "$CONFIG_RESOLVER" get "$OFFICE_DIR" office.task_prefix "")" || return 1
  fi

  ruby - "$task_id" "$task_prefix" "$OFFICE_DIR/office.team.yaml" <<'RUBY'
require "yaml"

task_id, raw_prefix, registry_path = ARGV
prefix = raw_prefix.to_s.strip.upcase
registry = {}

if File.exist?(registry_path)
  data = YAML.safe_load(File.read(registry_path))
  unless data.nil? || data.is_a?(Hash)
    abort "[ERROR] office.team.yaml must be a map"
  end
  raw = data.is_a?(Hash) ? data["prefixes"] : nil
  unless raw.nil? || raw.is_a?(Hash)
    abort "[ERROR] office.team.yaml 'prefixes:' must be a map"
  end
  registry = (raw || {}).each_with_object({}) do |(key, owner), memo|
    memo[key.to_s.strip.upcase] = owner.to_s
  end
end

exit 0 if registry.empty?
abort "[ERROR] set your Dashboard name before creating a task" if prefix.empty?
owner = registry[prefix]
abort "[ERROR] prefix #{prefix} is not registered" unless owner && !owner.empty?

expected = /\ATASK-#{Regexp.escape(prefix)}-\d+\z/
unless task_id.match?(expected)
  abort "[ERROR] new task id must use active namespace TASK-#{prefix}-NNN; run intake and use its returned id"
end
RUBY
}
```

Call it immediately before the existing PM `mkdir`:

```bash
if [[ "$AGENT" == "pm" && ! -d "$TASK_DIR" ]]; then
  enforce_new_task_namespace "$TASK_ID" || exit $?
  echo "Creating task directory: $TASK_DIR"
  mkdir -p "$TASK_DIR"
fi
```

Do not call the gate for an existing directory.

- [ ] **Step 4: Run prefix and operator integration tests**

Run:

```bash
bash tests/integration/team-prefix-registry.sh
bash tests/integration/operator-commands.sh
```

Expected: both scripts print `[PASS]`.

- [ ] **Step 5: Commit the runner gate**

```bash
git add run-agent.sh tests/integration/team-prefix-registry.sh
git commit -m "fix(office): enforce actor namespace for new tasks"
```

### Task 4: Close Hook, Prompt, and Guidance Leaks

**Files:**
- Create: `tests/integration/task-id-guidance-policy.sh`
- Modify: `agents/pm.md`
- Modify: `SKILL.md`
- Modify: `QUICKSTART.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/skills/office-intake.md`
- Modify: `profiles/games-labs.md`
- Modify: `templates/cursor/agents/ai-dev-office-pm.md`
- Modify: `templates/cursor/rules/ai-dev-office.mdc`
- Modify outside repository: `../.cursor/agents/ai-dev-office-pm.md`
- Modify outside repository: `../.cursor/rules/ai-dev-office.mdc`
- Modify outside repository: `../AGENTS.md`
- Modify outside repository: `../.github/copilot-instructions.md`

- [ ] **Step 1: Create a failing active-guidance policy test**

Create `tests/integration/task-id-guidance-policy.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

CREATION_FILES=(
  agents/pm.md
  SKILL.md
  docs/skills/office-intake.md
  templates/cursor/agents/ai-dev-office-pm.md
)

FORBIDDEN=(
  'starting or refining a TASK-NNN'
  'id: "<TASK-NNN>"'
  'next available TASK-NNN'
  'run-agent.sh TASK-NNN pm'
)

for rel in "${CREATION_FILES[@]}"; do
  for phrase in "${FORBIDDEN[@]}"; do
    if grep -Fq -- "$phrase" "$ROOT/$rel"; then
      echo "[FAIL] $rel recommends legacy new-task id: $phrase"
      exit 1
    fi
  done
done

grep -Fq 'run-agent.sh intake' "$ROOT/SKILL.md" \
  || { echo '[FAIL] SKILL must route new tasks through intake'; exit 1; }
grep -Fq 'TASK-<PREFIX>-NNN' "$ROOT/agents/pm.md" \
  || { echo '[FAIL] PM contract must describe namespaced new ids'; exit 1; }
grep -Fq 'TASK-<PREFIX>-NNN' "$ROOT/templates/cursor/agents/ai-dev-office-pm.md" \
  || { echo '[FAIL] Cursor PM trigger must describe namespaced ids'; exit 1; }

echo '[PASS] active task-id guidance follows Dashboard namespace policy'
```

- [ ] **Step 2: Run the policy test and verify it fails**

Run:

```bash
bash tests/integration/task-id-guidance-policy.sh
```

Expected: FAIL on the current PM trigger and PM contract.

- [ ] **Step 3: Update the authoritative PM contract**

Make these exact semantic changes in `agents/pm.md`:

```yaml
task:
  id: "<exact TASK_ID returned by intake>"
```

Replace rule 12 with:

```markdown
12. For a new task, run `./ai-dev-office/run-agent.sh intake "<request>"` and use the exact namespaced id it returns. Never invent a plain `TASK-NNN`; that form is legacy-only when a team registry is active.
```

Change workstream wording to say it does not alter `<TASK_ID>` or `runs/<task-id>` rather than naming `TASK-NNN`.

- [ ] **Step 4: Update active portable hook and operator surfaces**

Apply these rules consistently:

- `templates/cursor/agents/ai-dev-office-pm.md`: trigger text becomes “starting or refining a namespaced `TASK-<PREFIX>-NNN` or existing `<TASK_ID>`”.
- `templates/cursor/rules/ai-dev-office.mdc`: examples use `TASK-EAR-015`/`TASK-PKG-001`, and new PM work must consume the intake result.
- `SKILL.md`: show `intake` first, assign its output to `TASK_ID`, then use `./run-agent.sh "$TASK_ID" pm`.
- `docs/skills/office-intake.md`: recommended next command uses the returned `<TASK_ID>`.
- `docs/getting-started.md` and `QUICKSTART.md`: first-task flow starts with intake; existing-task command examples use `<TASK_ID>`.
- `profiles/games-labs.md`: runner examples use `<TASK_ID>`.

The canonical new-task example should be:

```bash
./ai-dev-office/run-agent.sh intake "Describe the task"
TASK_ID="TASK-<PREFIX>-NNN" # use the exact id printed by intake
./ai-dev-office/run-agent.sh "$TASK_ID" pm
```

Compatibility documentation may still list `TASK-NNN`, `TASK-PKG-NNN`, and `TASK-<PREFIX>-NNN`, but must label unprefixed IDs legacy.

- [ ] **Step 5: Align installed workspace hook copies and root instructions**

Patch `../.cursor/agents/ai-dev-office-pm.md` and `../.cursor/rules/ai-dev-office.mdc` to match their template sources. In `../AGENTS.md`, replace the new-run example with `<TASK_ID>` and state that new IDs come from intake/Dashboard identity. In `../.github/copilot-instructions.md`, replace “a task id like `TASK-NNN`” with “an existing `<TASK_ID>` such as `TASK-EAR-001`” so the trigger does not teach plain allocation.

Verify installed parity:

```bash
diff -u templates/cursor/agents/ai-dev-office-pm.md ../.cursor/agents/ai-dev-office-pm.md
diff -u templates/cursor/rules/ai-dev-office.mdc ../.cursor/rules/ai-dev-office.mdc
```

Expected: no output.

- [ ] **Step 6: Run policy and portability checks**

Run:

```bash
bash tests/integration/task-id-guidance-policy.sh
bash tests/integration/contract-foundation.sh
bash tests/integration/bootstrap-sync.sh
```

Expected: all scripts print `[PASS]`.

- [ ] **Step 7: Commit repository-owned hook and documentation changes**

```bash
git add \
  tests/integration/task-id-guidance-policy.sh \
  agents/pm.md SKILL.md QUICKSTART.md \
  docs/getting-started.md docs/skills/office-intake.md profiles/games-labs.md \
  templates/cursor/agents/ai-dev-office-pm.md \
  templates/cursor/rules/ai-dev-office.mdc
git commit -m "docs(office): require intake-owned task ids"
```

Do not stage any `runs/` artifact or unrelated workspace change.

### Task 5: Full Verification and Evidence Review

**Files:**
- Verify only; no new files expected.

- [ ] **Step 1: Run Dashboard server verification**

```bash
cd dashboard/server
npm test
npm run build
cd ../../
```

Expected: all Node tests PASS and TypeScript build exits 0.

- [ ] **Step 2: Run task-prefix and policy integration verification**

```bash
bash tests/integration/team-prefix-registry.sh
bash tests/integration/operator-commands.sh
bash tests/integration/task-id-guidance-policy.sh
bash tests/integration/contract-foundation.sh
bash tests/integration/bootstrap-sync.sh
```

Expected: every script prints `[PASS]`.

- [ ] **Step 3: Run schema and runtime regression checks**

```bash
bash tests/integration/schema-validator-parity.sh
bash -n run-agent.sh
ruby -c validate-yaml.rb
```

Expected: schema parity passes, Bash reports no syntax error, and Ruby reports `Syntax OK`. Runtime task validation is not required because this implementation does not modify any `runs/` artifact.

- [ ] **Step 4: Audit task-id language and working tree scope**

```bash
rg -n 'starting or refining a TASK-NNN|id: "<TASK-NNN>"|next available TASK-NNN|run-agent\.sh TASK-NNN pm' \
  agents SKILL.md docs templates QUICKSTART.md
git status --short
git log -6 --oneline
```

Expected: no active new-task guidance matches; compatibility/history references are explicitly legacy; only intended implementation changes and pre-existing untracked `runs/` artifacts remain.

- [ ] **Step 5: Perform a manual identity smoke check**

With the Dashboard running locally:

1. Save actor `Earth`; confirm the badge shows `TASK-EAR-...`.
2. Save a different Latin actor; confirm the badge switches to that actor's registered or derived prefix.
3. Switch back to `Earth`; confirm `EAR` is reused.
4. Run `./run-agent.sh intake "Prefix smoke test"`; confirm the preview uses the currently selected actor's prefix.
5. Do not run PM for the smoke-only preview, so no runtime task is created.

- [ ] **Step 6: Review commits without creating an extra completion commit**

```bash
git status --short
git log --oneline --decorate -8
```

Expected: implementation is represented by the focused commits above; no unrelated or runtime artifact is staged.
