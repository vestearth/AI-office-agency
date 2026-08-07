# TASK-EAR-234 — api-gateway: client IP is attacker-controlled; rate-limit middleware is unusable as written

## Type

fix

## Priority

low — but read the "why this is not urgent" note before deprioritising further

## Context

Found during the rate-limiting survey that produced TASK-EAR-233. Split out
deliberately: TASK-EAR-233 fixes the exploitable gap, this run fixes two latent
defects that only bite once something makes an IP-keyed decision.

The operator confirmed **Cloudflare rate limiting is enabled**, which is why the
gateway limiter is not being wired and this is not urgent.

## Finding 1 — `c.ClientIP()` is attacker-controlled

`SetTrustedProxies` and `TrustedPlatform` are **never called** anywhere in
api-gateway — verified by grep across `origin/staging`.

gin v1.11.0 therefore keeps its default `trustedProxies: ["0.0.0.0/0", "::/0"]`
with `ForwardedByClientIP: true`. `validateHeader` walks `X-Forwarded-For`
right-to-left and, with everything trusted, returns the **leftmost** entry — which
is whatever the client sent. The real path is Cloudflare → API Gateway → VPC Link
→ internal ALB, so an XFF header is always present and always appended to.

**Any IP-keyed decision in this service is therefore spoofable with one header.**
Today nothing IP-keyed is wired, so this is latent rather than exploited — but it
is a prerequisite for anything that ever is, and it also means any IP recorded in
logs for forensic purposes is untrustworthy.

Fix: call `SetTrustedProxies` with the actual ALB/API-Gateway CIDRs, or set
`TrustedPlatform` to the Cloudflare header if Cloudflare is the terminating hop
that can be trusted. **Which one is correct depends on the real network path and
is an operator question, not a code guess.**

## Finding 2 — the rate-limit middleware cannot express per-route limits

`api-gateway/middleware/ratelimit.go` exists and is referenced only in
`EXAMPLES.md` / `README.md`. Wired nowhere. Two defects:

1. **Global singleton.** `getLimiter` uses a package-level `sync.Once` +
   `globalLimiter` (`:33-45`), so the **first** `RateLimit()` call's config wins
   forever. Worse, enforcement reads `rl.config.*` (`:74-96`) while the response
   headers read the caller's local `config.Requests` (`:127`) — so a second route
   would silently enforce the first route's limit **while advertising its own**.
2. **Shared key namespace.** The default KeyFunc returns a bare IP with no route
   prefix, so every IP-keyed route shares one bucket.

Also **fixed-window**, not token bucket (`:85-88`): resets at a wall-clock
boundary, allowing a 2× burst across it.

## Finding 3 — a config knob that does nothing

`config/auth_config.go:14-19` declares `RateLimitConfig{Enabled, Requests: 100,
Window: 60}` which nothing reads. An operator setting `RATE_LIMIT_ENABLED=true`
would reasonably believe they had turned something on.

It also uses the broken `envconfig:"NAME default=X"` tag form (space instead of
the required separate `default:"X"` tag) — the same class of trap recorded in the
`envconfig-default-tag-empty-trap` note.

Either wire it or delete it. A knob that lies is worse than no knob.

## Why this is not urgent

- Cloudflare already bounds per-IP volume at the edge.
- Nothing in api-gateway currently makes an IP-keyed decision, so finding 1 is
  latent.
- The exploitable gap — unbounded OTP guessing and unbounded email sending — is
  TASK-EAR-233 and is fixed in Auth with Postgres counters, which are immune to
  both of these defects.

## Why it should not be deleted from the backlog either

The moment anyone wires this middleware — or writes any other IP-based logic, or
trusts a logged IP during an incident — finding 1 makes it wrong, and finding 2
makes it wrong in a way that **looks** right because the headers report the limit
the caller configured.

## Scope

1. Configure proxy trust correctly (needs the operator to confirm the terminating
   hop).
2. Either fix the middleware — kill the singleton, namespace keys per route,
   consider a sliding window — or delete it along with the dead config, and say
   which and why.
3. Remove or wire `RateLimitConfig`.

## Acceptance criteria

- `c.ClientIP()` returns the real client IP and cannot be overridden by a
  client-supplied header — prove it with a test that sends a forged
  `X-Forwarded-For`.
- If the middleware is kept: two routes with different limits each enforce their
  own, and the `X-RateLimit-*` headers match what is actually enforced. If it is
  deleted: nothing references it and the docs no longer advertise it.
- `GOWORK=off go build -mod=readonly ./... && go vet ./... && go test ./...` green.
- PR base `staging`, do not merge.

## Out of scope

- Wiring rate limiting to any route — Cloudflare covers it; revisit only if the
  edge protection is ever removed.
- TASK-EAR-233's Auth-side counters.
