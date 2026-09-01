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

### THIS run (TASK-EAR-253) — still open, unchanged

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
query on `[VP][CreatePlayer]` settles it.

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

NOT yet confirmed — do not state as fact: the leading explanation is TLS
interception on that device (VPN, antivirus, MDM, or a debugging proxy presenting
a user-store CA), which fits device-vs-emulator exactly. Clock skew and a missing
root are not excluded. The decisive artifact is the raw `SslError` primary code,
which the client already logs in its `onReceivedSslError` handler
(`adb logcat | grep -i onReceivedSslError`). TRAP: that logger returns early
unless `BuildConfig.DEBUG`, so a release build emits nothing — use a debug build
before concluding the log is missing.

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
