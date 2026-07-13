import type {
  AgentName,
  ModelRoutingPreview,
  ModelRoutingReason,
  ModelRoutingTier,
  TaskWorkstream,
} from '@shared/types';

type PlainObject = Record<string, unknown>;

export interface ModelRoutingEvidence {
  taskId: string;
  pmOutput?: unknown;
  currentAgent?: AgentName;
  workstream?: TaskWorkstream;
  taskMarkdown?: string;
}

const ROUTABLE_ROLES = new Set<AgentName>([
  'pm', 'dev', 'dev-2', 'reviewer', 'debugger', 'devops', 'free-roam',
]);

function object(value: unknown): PlainObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as PlainObject
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function role(value: unknown): AgentName | undefined {
  const candidate = text(value).toLowerCase() as AgentName;
  return ROUTABLE_ROLES.has(candidate) ? candidate : undefined;
}

function addReason(
  reasons: ModelRoutingReason[],
  code: string,
  label: string,
  evidence: string,
): void {
  if (!reasons.some((reason) => reason.code === code)) {
    reasons.push({ code, label, evidence });
  }
}

function routeForTier(tier: ModelRoutingTier, selectedRole: AgentName): Pick<
  ModelRoutingPreview,
  'model' | 'modelLabel' | 'reasoningEffort'
> {
  if (tier === 'mechanical') {
    return { model: 'gpt-5.6-luna', modelLabel: '5.6 Luna', reasoningEffort: 'low' };
  }
  if (tier === 'standard') {
    return { model: 'gpt-5.6-terra', modelLabel: '5.6 Terra', reasoningEffort: 'medium' };
  }
  if (tier === 'complex') {
    return { model: 'gpt-5.6-terra', modelLabel: '5.6 Terra', reasoningEffort: 'high' };
  }
  return {
    model: 'gpt-5.6-sol',
    modelLabel: '5.6 Sol',
    reasoningEffort: selectedRole === 'debugger' || selectedRole === 'free-roam' ? 'xhigh' : 'high',
  };
}

export function buildModelRoutingPreview(input: ModelRoutingEvidence): ModelRoutingPreview {
  const candidateRoot = object(input.pmOutput);
  const candidateTask = object(candidateRoot.task);
  const hasValidatedPmOutput = text(candidateTask.id) === input.taskId;
  const root = hasValidatedPmOutput ? candidateRoot : {};
  const task = object(root.task);
  const scope = object(root.scope);
  const plan = object(root.plan);
  const assignment = object(root.assignment);
  const nextAction = object(root.next_action);

  const services = list(scope.target_services);
  const affectedFiles = list(scope.affected_files);
  const risks = list(plan.risks);
  const complexity = text(plan.estimated_complexity).toLowerCase();
  const priority = text(task.priority).toLowerCase();
  const workstream = text(task.workstream || input.workstream).toLowerCase();
  const selectedRole = input.currentAgent && input.currentAgent !== 'unknown'
    ? input.currentAgent
    : role(assignment.primary) || role(nextAction.agent) || 'dev';

  const evidenceText = [
    text(task.title),
    text(root.description),
    text(plan.approach),
    input.taskMarkdown || '',
    ...risks.map((entry) => {
      const risk = object(entry);
      return `${text(risk.risk)} ${text(risk.mitigation)}`;
    }),
    ...affectedFiles.map((entry) => {
      const file = object(entry);
      return `${text(file.path)} ${text(file.description)}`;
    }),
  ].join('\n').toLowerCase();

  const reasons: ModelRoutingReason[] = [];
  let tier: ModelRoutingTier = 'standard';

  const criticalSignals: Array<{ code: string; label: string; pattern: RegExp }> = [
    {
      code: 'contract_change',
      label: 'Contract or integration boundary',
      pattern: /(?:\.proto\b|protobuf|\bgrpc\b|api contract|event schema|contract change|gateway mapping)/i,
    },
    {
      code: 'sensitive_domain',
      label: 'Sensitive runtime or data domain',
      pattern: /\b(?:authentication|authorization|security|secret|payment|wallet|production|migration|idempotenc\w*)\b/i,
    },
  ];

  if (services.length >= 2) {
    tier = 'critical';
    addReason(reasons, 'multi_service', 'Multiple services in scope', `${services.length} target services`);
  }
  if (priority === 'critical') {
    tier = 'critical';
    addReason(reasons, 'critical_priority', 'Critical task priority', 'task.priority = critical');
  }
  for (const signal of criticalSignals) {
    if (signal.pattern.test(evidenceText)) {
      tier = 'critical';
      addReason(reasons, signal.code, signal.label, 'matched validated task text or affected paths');
    }
  }

  if (tier !== 'critical') {
    if (priority === 'high') {
      tier = 'complex';
      addReason(reasons, 'high_priority', 'High task priority', 'task.priority = high');
    }
    if (complexity === 'high') {
      tier = 'complex';
      addReason(reasons, 'high_complexity', 'High estimated complexity', 'plan.estimated_complexity = high');
    }
    if (selectedRole === 'dev-2') {
      tier = 'complex';
      addReason(reasons, 'senior_role', 'Senior implementation role', 'next role = dev-2');
    }
    if (assignment.parallel === true) {
      tier = 'complex';
      addReason(reasons, 'parallel_work', 'Parallel implementation lanes', 'assignment.parallel = true');
    }
  }

  if (
    tier === 'standard' &&
    workstream === 'docs' &&
    (complexity === '' || complexity === 'low') &&
    (priority === '' || priority === 'low' || priority === 'medium') &&
    services.length <= 1
  ) {
    tier = 'mechanical';
    addReason(reasons, 'docs_workstream', 'Clear documentation work', 'task.workstream = docs');
  }

  if (reasons.length === 0) {
    addReason(reasons, 'standard_default', 'Scoped everyday work', 'no higher-risk routing rule matched');
  }
  addReason(reasons, 'role_context', 'Role-specific preview', `next role = ${selectedRole}`);

  const selected = routeForTier(tier, selectedRole);
  const source = hasValidatedPmOutput
    ? 'validated-task'
    : input.currentAgent || input.workstream || input.taskMarkdown
      ? 'run-metadata'
      : 'fallback';

  return {
    mode: 'auto',
    previewOnly: true,
    role: selectedRole,
    tier,
    ...selected,
    speed: 'standard',
    source,
    reasons,
  };
}
