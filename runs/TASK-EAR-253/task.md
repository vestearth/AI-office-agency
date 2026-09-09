# TASK-EAR-253 — Provider VP Error

> Promoted from Central Intake INTAKE-e719fe7abeb59e2608 (projection promo.v2).
> Reporter: reporter:INTAKE-e719fe7abeb59e2608

## Summary
{
  "status": {
    "code": 1000,
    "description": "provider error (code 1000): vp launch failed: member code=11 msg=Parameters error."
  },
  "launchUrl": "",
  "token": ""
}

## Product scope


## Severity
high

## Steps to reproduce
{
  "status": {
    "code": 1000,
    "description": "provider error (code 1000): vp launch failed: member code=11 msg=Parameters error."
  },
  "launchUrl": "",
  "token": ""
}

## Triage

Updated 2026-08-31 (Claude advisory lane). Two separate issues were conflated in
this run; they are split below.

### THIS run (TASK-EAR-253) — original `code=11` intake (closed unreproduced 2026-09-09)

`provider error (code 1000): vp launch failed: member code=11 msg=Parameters error.`
with `launchUrl: ""`. That `code=11` is OURS, not VP's: `vpCodeParamError = 11`
and `vpMsgParamError = "Parameters error."` are defined in Games-Labs-Provider
`internal/core/services/vp/service.go:34-35` and returned with HTTP 200 from
`vpService.CreatePlayer` BEFORE VP is ever called. Reading it as "VP rejected us"
is a misreading. The guards that emit the bare message are: empty resolved
display_name, display_name longer than 25, or display_name failing
`reVPUsername = ^[A-Za-z0-9]{1,25}$` (:48) — so a Thai, spaced or punctuated
display name is rejected by us. The `USER_API_URL` branch is excluded: it returns
a long descriptive message, not this one. Root cause not yet pinned to one guard;
each logs a distinct line carrying the actual display_name, so one CloudWatch
query on `[VP][CreatePlayer]` would have settled it. Operator closed the run
2026-09-09 without that query: play is normal, the live 2026-08-31 launch was
`CreatePlayer code=6`, and no player was ever attached to this intake. Reopen
if a new report includes those log lines.

### The 2026-08-31 black-screen report — NOT this bug, do not merge

A tester reported a VP game hanging on a black screen. Investigated the same day
and traced to the CLIENT, not the backend.

Verified:
- Backend returns a valid, working launch URL. Live call to
  `POST https://api-dev.gameslabs.app/vp/launch-game` returned `gameLaunchUrl`
  (host `gp001-stage1-cdn.oydev.net`), no `gameLaunchHtml`; following it gave
  `301 -> 200`, `text/html`, `<title>Vertex Play</title>`.
- The VP chain passed every step: Auth ok, `CreatePlayer code=6` ("username
  already exist" — healthy; `isVPMemberAlreadyExists` returns true and the flow
  continues), `GetOpenGame code=0`. Nothing like this run's `code=11`.
- No deploy is implicated. Backoffice `9b1adae` has zero game-launch surface and
  `apiBearer` never existed in Game/Provider/api-gateway; Games-Labs-User
  `9498e17` touched only `player_activity_publish.go`; api-gateway `b64f7dc`
  touched only a coupon test plus a go.mod bump.
- The failure is the Android app's own SSL handler. The dialog text "Unable to
  securely load the game." comes from `GameWebViewClientController.sslError`
  (Android client repo, read-only reference), invoked from the WebView's
  `onReceivedSslError`, which calls `handler.cancel()`. The app is behaving
  CORRECTLY by refusing a certificate it cannot validate.
- That app trusts system CAs only (no `android:networkSecurityConfig`,
  `targetSdk = 36`, no `CertificatePinner`, no custom trust manager), so a
  user-store CA is not trusted.
- Every host on the launch path verifies cleanly from an up-to-date machine:
  api-dev.gameslabs.app, gp001-stage1-cdn.oydev.net, and the game shell's
  third-party RUM host dl.lfyanwei.com.
- Reproduces on the tester's physical device only; BlueStacks plays the game
  normally.

CONFIRMED 2026-09-09 — not TLS interception. The app team collected the
artifacts this triage asked for (SslError, WebView version, OS, networks, no
VPN/AV). The served CDN chain for `gp001-stage1-cdn.oydev.net` anchored to
**AAA Certificate Services**, which Android 16 Conscrypt on the affected Xiaomi
does not trust; BlueStacks still does. The same leaf validates on that phone
via SSL.com's alternate intermediate to **SSL.com TLS RSA Root CA 2022**.
Games Labs sent that diagnosis to VP's CDN/TLS team; play recovered after a
VP-side change. Exact CDN edit is unknown (not ours). Full write-up below.

Two earlier hypotheses were tested and REFUTED; do not re-propose. (1) Display
name failing the VP username regex — the observed `CrystalPhoenix4793` is 19
alphanumeric chars and passes, and the log tag was `[VP][OUT]`, so it reached VP.
(2) The backend returning `gameLaunchHtml` in the `launchUrl` slot — VP returned a
real URL. That code inconsistency is real but is not this symptom.

Testing trap found along the way: `POST /vp/launch-game` takes `gameCode`,
`ipaddress` (lowercase i) and `lang`. The Game/gRPC shape (`gameId`, `ipAddress`,
`language`) decodes to empty strings and returns `code:11 "Parameters error."` —
a testing artifact, not a defect. Both shapes were verified. That endpoint also
has no authentication (`withProvider` only injects a context key), which is
adjacent to the open work in TASK-EAR-266 / TASK-EAR-275.

## Resolution 2026-09-09 — black-screen / secure-load (VP CDN TLS chain)

This closed the 2026-08-31 black-screen thread. Operator closed the whole run
2026-09-09: play is normal again; the leftover `code=11` intake is accepted as
unreproduced (see Close below).

### What the app team proved

The Android lane sent this diagnosis to VP (verbatim substance; operator
forwarded 2026-09-09 after play recovered):

- Automatic date and time enabled.
- No VPN, ad-blocking, or antivirus installed or in use.
- Same secure-load error on Wi-Fi and the phone's mobile data.
- Android System WebView: Google `com.google.android.webview` **151.0.7922.199**.
- Android **16**, API **36**. Device: Xiaomi **2409FPCC4G**.
- Apollo, Awakening Aztec, and Gems of Ra all showed the same secure-load error.
- Debug logs: `CertPathValidatorException: Trust anchor for certification path not found`.
- Chromium: `ERR_CERT_AUTHORITY_INVALID` for `gp001-stage1-cdn.oydev.net`.
- The currently served intermediate chained to the **AAA Certificate Services**
  root, which is **absent** from that phone's current Conscrypt trust store.
- BlueStacks still trusts that AAA root; the Android 16 device store does not.
  Replaying the CDN chain against those two stores reproduces pass vs fail.
- The same server certificate validates against the phone's store when chained
  through SSL.com's alternate intermediate to **SSL.com TLS RSA Root CA 2022**.
- Ask: VP CDN/TLS team to review the served intermediate chain.

### What happened after that message

VP changed something on their CDN/TLS side (exact edit unknown — not a Games
Labs deploy). Games then loaded normally again. No Games-Labs-Provider,
api-gateway, or Android code change was required for this recovery.

### What this refutes

Do **not** keep "TLS interception on that device" as the leading explanation
for this incident. The collected artifacts kill VPN/AV/MDM/proxy as the cause
here. Device-vs-BlueStacks was a **system trust-store mismatch** on a served
intermediate, not a user-store interceptor.

Our backend remaining all-green is still correct. The owner of the fix was
VP's CDN/TLS chain, not `handler.proceed()` and not a Games Labs launch-URL
change.

Vault notes:
- knowledge-base/Knowledge Base/40 Lessons/All-Green Backend Plus A Client Security Dialog Is Not A Backend Bug.md
- knowledge-base/Knowledge Base/10 Projects/Games Labs Provider/VP CDN Intermediate Chain vs Android 16 Trust Store (TASK-EAR-253).md

## Close 2026-09-09 — operator directed

Run closed `done`. No Games Labs code change.

- User-facing symptom (secure-load / black screen on Android 16) recovered after
  VP's CDN/TLS change. Recorded above.
- Original intake `code=11 Parameters error.` accepted as **unreproduced**.
  Live launch on 2026-08-31 was `CreatePlayer code=6` with a working URL.
  Operator confirmed play is normal. Reopen if a new report includes
  `[VP][CreatePlayer]` logs.
- Independent leftover: Review Queue still wants a live openssl probe of
  `gp001-stage1-cdn.oydev.net`, or an explicit historical accept. That does
  not keep this run open.
