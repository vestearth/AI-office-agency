// Client-side access-code format help.
//
// An access code is what `intake:ops issue-code` prints on its
// "Code (shown once, …)" line: 32 lowercase hex chars, no prefix
// (`randomToken(16)` server-side). A Tester ID (`TSTR-<18 hex>`) is printed on
// the line ABOVE it and is NOT a credential — pasting it is the single most
// likely tester mistake, so we name it explicitly.
//
// These checks are deliberately LOCAL ONLY: they validate shape, never
// existence. The server keeps returning a generic "Invalid code" so it leaks
// no signal about which codes exist (enumeration resistance, verified in
// deploy/verification-checklist.md § 2).

const CODE_RE = /^[0-9a-f]{32}$/;
const TESTER_ID_RE = /^tstr-/;

/**
 * Forgiving normalisation of pasted input. Codes are always lowercase hex by
 * construction, so lowercasing and dropping whitespace can only ever turn a
 * mistyped code into a valid one — never the reverse.
 */
export function normalizeCode(raw: string): string {
  return raw.trim().replace(/\s+/g, '').toLowerCase();
}

/**
 * Returns a human-facing message when the input cannot possibly be an access
 * code, or null when the shape is right and it's worth asking the server.
 */
export function codeFormatError(normalized: string): string | null {
  if (!normalized) return null; // empty is handled by the disabled submit button
  if (TESTER_ID_RE.test(normalized)) {
    return 'That looks like a Tester ID, not your access code. The code is 32 characters with no "TSTR-" prefix — use the line that starts with "Code".';
  }
  if (!CODE_RE.test(normalized)) {
    return 'An access code is exactly 32 characters using only a–f and 0–9. Check that you copied the whole code.';
  }
  return null;
}
