// Operator-model-aware display for timeline actors (knowledge-base ADR-0003 /
// ADR-0004). A timeline actor may be a role (the workflow contract), an operator
// (conductor/subagent — who ran it), or an actor (orchestrator/user/done).
// Keyed by lowercased name; falls back to the `unknown` glyph.
export const AGENT_EMOJI: Record<string, string> = {
  // roles (workflow contract)
  pm: '🧑‍💼', dev: '👷', 'dev-2': '👩‍🔧', reviewer: '🕵️', debugger: '🐛',
  devops: '🛠️', 'free-roam': '🦸',
  // actors
  done: '✅', orchestrator: '🎛️', user: '🙋',
  // operators (conductor / subagent — who ran it)
  claude: '🟣', codex: '🤖', cursor: '🖱️', gemini: '✨',
  unknown: '❔',
};

export function agentGlyph(agent?: string): string {
  return AGENT_EMOJI[(agent || 'unknown').toLowerCase()] || AGENT_EMOJI.unknown;
}

// Display order for the legend panels. Roles (the workflow contract) and
// operators (conductors/subagents) are listed separately so each panel only
// shows the dimension it counts.
export const ROLE_NAMES = ['pm', 'dev', 'dev-2', 'reviewer', 'debugger', 'devops', 'free-roam'];
export const OPERATOR_NAMES = ['claude', 'codex', 'cursor', 'gemini'];

// Colour per AgentKind. Operators ("who ran it") read distinctly from the role
// contract; actors/unknown are muted.
export const KIND_COLOR: Record<string, string> = {
  role: 'var(--text-primary)',
  operator: '#a78bfa',
  actor: 'var(--text-secondary)',
  unknown: 'var(--text-secondary)',
};
