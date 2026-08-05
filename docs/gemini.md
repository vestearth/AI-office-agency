# Gemini → Antigravity (superseded)

**Status:** Superseded 2026-08-05.

The office **research / wide-context subagent** slot is **Antigravity CLI**, not
a standalone Gemini operator. Use [antigravity.md](antigravity.md).

Earlier drafts (and ADR-0003's original wording) named this slot "Gemini". That
was documentation drift: Antigravity is the operator surface; Gemini may appear
only as a chat/model surface inside it.

**Out of scope here:** Games Labs User admin translate (`GEMINI_API_KEY` /
`GEMINI_MODEL`) remains a product API integration and is unrelated to this
operator lane.

## Historical note

The 2026-06-05 "Claude + Gemini manual advisory lanes" plan introduced
`docs/gemini.md` as a manual advisory lane. That role is now documented under
Antigravity CLI. Keep this file as a redirect so old links and
`install-manifest.yaml` entries do not 404.
