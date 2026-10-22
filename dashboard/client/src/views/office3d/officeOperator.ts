/** Last-writer operator. Kept out of `officeCharacters` so selection data does not import the scene module. */
export const CHARACTER_OPERATORS = ['claude', 'codex', 'cursor', 'antigravity', 'copilot', 'unknown'] as const;
export type CharacterOperator = (typeof CHARACTER_OPERATORS)[number];

const KNOWN = new Set<string>(CHARACTER_OPERATORS.filter((name) => name !== 'unknown'));

export function characterOperator(raw: string | null | undefined): CharacterOperator {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'gemini') return 'antigravity';
  return KNOWN.has(value) ? (value as CharacterOperator) : 'unknown';
}

export function lastOperatorLabel(operator: string | null | undefined): string {
  return `last operator: ${characterOperator(operator)}`;
}
