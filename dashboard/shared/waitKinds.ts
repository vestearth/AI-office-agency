// status.yaml waits_on[].kind (validate-yaml.rb WAIT_KINDS) and how the
// dashboard names each. Runtime module, like runCounts and releaseLadder.
export const WAIT_KINDS = ['prod_run', 'aws_permission', 'operator_decision', 'operator_approval', 'qa', 'external'] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

export const WAIT_KIND_LABEL: Record<WaitKind, string> = {
  prod_run: 'approval to run prod',
  aws_permission: 'an AWS permission',
  operator_decision: 'an operator decision',
  operator_approval: 'an operator approval',
  qa: 'manual QA',
  external: 'an external party',
};

export function isWaitKind(value: unknown): value is WaitKind {
  return typeof value === 'string' && (WAIT_KINDS as readonly string[]).includes(value);
}
