import type { GateEntry } from '../../../shared/types';

// Issue #28 Phase 2F: display rules for the Monitor Completion Gates card. The
// gate state itself comes from the server (CompletionGuard.gate_view); these
// only choose how to show it.

export type GateTone = 'resolved' | 'na' | 'pending' | 'unresolved';

/** A pass/na the guard does not count as resolved is a problem, not a success. */
export function gateTone(gate: GateEntry): GateTone {
  if (gate.status === 'pass' || gate.status === 'na') {
    if (!gate.resolved) return 'unresolved';
    return gate.status === 'pass' ? 'resolved' : 'na';
  }
  return gate.status === 'pending' ? 'pending' : 'unresolved';
}

/** The run URL only when it is http(s); anything else (javascript:, data:, relative) is not linked. */
export function safeRunUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}
