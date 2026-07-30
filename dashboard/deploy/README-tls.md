# Intake Board — TLS Reverse Proxy Runbook (M3 Phase B, Task 6)

Closes the M1 deployment prerequisite: the tester session cookie is set with
`Secure: true` unconditionally (`routes/intake/auth.ts`), so without TLS in
front of the Central service, LAN testers over plain `http://` never get a
usable session — the cookie is silently dropped by the browser. This runbook
puts a TLS-terminating reverse proxy (Caddy, or nginx as an alternative) in
front of the Central Intake service and locks the Express app down to
loopback-only so the proxy is the sole LAN-facing listener.

**Run this on the Central host** (`192.168.1.140` at the time of writing).
Executes in ~15–20 minutes assuming Caddy installs cleanly.

## Prerequisites

- Central host reachable via SSH or a local shell.
- `sudo`/root on the Central host (to install Caddy and bind port 443).
- M3 Phase A already deployed (real admin credential provisioned — see
  `dashboard/server/.env.example` and `intake:ops provision-admin`).
- No active testers right now — Step 3 below interrupts direct `:4310` access
  until Caddy is confirmed working.

## Step 1 — Choose the internal hostname

Pick one and register it. Two options:

**(a) LAN DNS** (if you run one) — add an A record:
```
intake.games-labs.lan  A  192.168.1.140
```

**(b) Per-tester hosts file** (no LAN DNS available) — on each tester
machine, append to `/etc/hosts` (macOS/Linux) or
`C:\Windows\System32\drivers\etc\hosts` (Windows, as Administrator):
```
192.168.1.140  intake.games-labs.lan
```

This runbook uses `intake.games-labs.lan` throughout — replace every
occurrence with your actual chosen hostname if different (this is a
`[PLAN-ASSUMPTION]`, not a fixed requirement).

## Step 2 — Install and start Caddy on the Central host

```bash
# Debian/Ubuntu:
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# macOS (if Central runs on a Mac):
brew install caddy
```

Copy `dashboard/deploy/Caddyfile` to the Central host (edit the hostname
inside it first if you didn't use the default), then run Caddy against it:

```bash
sudo caddy run --config /path/to/Caddyfile
# or, to run as a background service:
sudo caddy start --config /path/to/Caddyfile
```

Caddy's `tls internal` directive generates and uses its own internal CA on
first run — no manual cert issuance needed. Confirm it started without
errors and is listening on 443:

```bash
sudo ss -tlnp | grep :443
```

## Step 3 — Bind the Central Express app to loopback only

Set in the Central server's environment (`.env` or the process manager's env)
and **restart the dashboard server**:

```bash
DASHBOARD_HOST=127.0.0.1
DASHBOARD_ALLOWED_ORIGINS=https://intake.games-labs.lan
```

`DASHBOARD_HOST` was added to `dashboard/server/src/config.ts` for this
runbook — unset (the prior default) binds all interfaces unchanged; setting
it to `127.0.0.1` makes the app unreachable except through Caddy. The
`app.listen` startup log will print `Bound to 127.0.0.1 only — reachable via
a reverse proxy, not directly.` when this is active — confirm you see that
line after restart.

`DASHBOARD_ALLOWED_ORIGINS` must be the **HTTPS** hostname now, since the
tester client is served same-origin through Caddy — this is also what the
CSRF guard's origin allowlist checks (`middleware/csrf.ts`), so a stale
plain-HTTP entry here will make every tester POST return `403 {"error":"Origin
not allowed"}`.

Restart the server, then confirm:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4310/api/health   # 200 — still reachable from the host itself
curl -s -o /dev/null -w '%{http_code}\n' --connect-timeout 3 http://192.168.1.140:4310/api/health  # from a DIFFERENT machine — must time out / refuse
```

## Step 4 — Distribute Caddy's internal root CA to tester machines

```bash
# On the Central host, Caddy stores its internal root CA here by default:
sudo caddy trust
# ...or locate the file directly (path varies by OS/install):
find / -iname "root.crt" -path "*caddy*" 2>/dev/null
```

Copy the root CA file to each tester machine and trust it:

- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain root.crt`
- **Windows:** double-click the `.crt` → "Install Certificate" → Local Machine → "Place all certificates in the following store" → Trusted Root Certification Authorities.
- **Linux (Debian/Ubuntu):** `sudo cp root.crt /usr/local/share/ca-certificates/caddy-root.crt && sudo update-ca-certificates`

Without this step, testers' browsers show a certificate warning (not a
hard failure, but confusing for non-technical testers — do this before
handing out access codes).

## Step 5 — Verify (acceptance test for this task)

From a **second machine on the LAN** (not the Central host itself):

```bash
# (a) cert trusted — no -k / --insecure flag, should succeed cleanly:
curl -sv https://intake.games-labs.lan/api/health 2>&1 | grep -E "SSL certificate|HTTP/"

# (b) Secure cookie now works end-to-end — exchange a real access code
#     (mint one first with `npm run intake:ops -- issue-code --label "Verify"`
#     on the Central host) and confirm the response sets intake_sid + the
#     follow-up request is accepted, not 401:
curl -si -X POST https://intake.games-labs.lan/api/intake/session \
  -H 'Content-Type: application/json' -H 'Origin: https://intake.games-labs.lan' \
  -d '{"code":"<the code>"}'
#   -> 200, Set-Cookie: intake_sid=...; Secure; HttpOnly; SameSite=Strict

# (c) plain :4310 is NOT reachable from off-box (loopback bind confirmed):
curl -s -o /dev/null -w '%{http_code}\n' --connect-timeout 3 http://192.168.1.140:4310/api/health
#   -> connection refused / timeout, NOT 200

# (d) attachment cap enforced through the proxy — a body at the 5MB
#     attachment cap succeeds; a 6MB+ body is rejected by Caddy's
#     `request_body { max_size 6MB }` before it reaches the app:
dd if=/dev/urandom of=/tmp/at-cap.bin bs=1M count=5 2>/dev/null
dd if=/dev/urandom of=/tmp/over-cap.bin bs=1M count=7 2>/dev/null
# (submit each as an attachment on a claimed session per the tester API —
#  see routes/intake/attachments.ts for the exact multipart shape)
```

All four must pass before this task is considered done. Record the outcome
in `dashboard/deploy/verification-checklist.md` (Task 7) alongside the rest
of the end-to-end pass.

## nginx alternative

If you prefer nginx over Caddy, use `dashboard/deploy/nginx.conf.example`
instead of Step 2/`Caddyfile`. You'll need to generate your own cert since
nginx has no built-in internal CA — one option:

```bash
# Minimal self-signed internal CA (run once, keep the CA key private):
openssl genrsa -out ca.key 4096
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt \
  -subj "/CN=Games Labs Internal CA"

# Leaf cert for the hostname:
openssl genrsa -out intake.games-labs.lan.key 2048
openssl req -new -key intake.games-labs.lan.key -out intake.csr \
  -subj "/CN=intake.games-labs.lan"
openssl x509 -req -in intake.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out intake.games-labs.lan.crt -days 825 -sha256

# Distribute ca.crt to tester trust stores exactly as in Step 4.
```

Steps 3–5 above are identical regardless of which proxy you use.
