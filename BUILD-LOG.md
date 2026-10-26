# FeeDesk AI — Build Log

## 2026-10-26 — Mock-mode build (approved early start; window was Oct 28)

Krupal approved starting the build on 26 Oct instead of waiting for the
planned Oct 28 window. No PayPal credentials exist yet, so everything was
built and verified in mock mode.

### What was built

- **Mock PayPal engine (`paypal/mock.js`)** — simulates order creation
  (`MOCK-ORDER-xxxx`), payer approval (`CHECKOUT.ORDER.APPROVED`), capture
  with four outcomes (completed / pending / denied / refunded), and refunds,
  with realistic PayPal-shaped payloads. Mock webhooks are HMAC-SHA256
  signed (keyed by `MOCK_WEBHOOK_SECRET`, dev-only default) so signature
  verification can be tested end to end. Labelled mock-only everywhere;
  live mode always calls PayPal's real verify endpoint.
- **Fee ledger (`lib/store.js`)** — in-memory fee store with the settlement
  state machine: AWAITING_APPROVAL → APPROVED → SETTLED / PENDING / DENIED /
  REFUNDED. Status changes only from verified PayPal facts (capture response
  or verified webhook). Unverified webhooks are logged and shown as
  UNVERIFIED, and never change a fee's status.
- **Mode dispatch (`paypal/client.js`)** — `PAYPAL_MODE=mock` routes create /
  get-order to the mock engine; live mode is unchanged (real sandbox APIs,
  credentials from env only, graceful 503 without them). Mock webhook
  signatures verify locally; live webhooks still go to PayPal's verify
  endpoint.
- **AI explainer (`ai/explain.js`)** — rule-based explainer remains the
  default (offline, no key). Optional LLM path added: GROQ_API_KEY first,
  then GEMINI_API_KEY, 15 s timeout, strict JSON parse; any failure falls
  back to the rules silently. Response carries `source: "llm"` or
  `source: "rules-fallback"`. No key exists on this machine; the LLM path
  has never run.
- **Server (`server.js`)** — new routes: `GET /fees`, `GET /fees/:feeId`,
  `POST /fees/:feeId/explain`, `POST /mock/approve`,
  `GET /mock-approve/:orderId` (the mock "PayPal approve link", 302 back to
  the desk), `POST /mock/refund`, `GET /health` (now reports mode + LLM
  status). Webhook processing is one shared function used by the public
  `/webhook` route and by mock event delivery, so mock and live go through
  the same verified pipeline.
- **Desk page (`public/index.html`)** — rewritten: create-fee form, fee
  table with status badges, mock payer controls (approve, capture with
  outcome selector, refund), Explain buttons, explanation panels, webhook
  event log with verification column, mode banner (mock = yellow warning).
- **Samples (`samples/`)** — added denied, pending, refunded and
  order-approved webhook payloads alongside the existing completed one.
- **Tests** — `npm test` now runs `test/smoke.js` (8 checks, live mode,
  no credentials) + new `test/mock-flow.js` (28 checks, mock mode).
- **Docs** — README status updated from "scaffold" to mock-mode complete
  with an honest not-done list; `.env.example` documents `PAYPAL_MODE`,
  `MOCK_WEBHOOK_SECRET`, `GROQ_API_KEY` / `GEMINI_API_KEY`.

### Verification (2026-10-26)

- `npm test`: **36 passed, 0 failed** (smoke 8/8, mock-flow 28/28).
  Covers: order creation, webhook signature valid + tampered (unit and
  HTTP), unverified webhook never changing status, all four settlement
  transitions, explainer output for all five event types, fee explain
  endpoint, mock-only routes refused in live mode.
- Live curl end-to-end (mock mode, port 3456): create order → mock approve
  → capture completed → fee SETTLED (webhook verified=true, applied=true)
  → explain returns "Fee settled — payment received" (rules-fallback);
  denied flow → DENIED with "Payment failed — fee NOT paid" + retry next
  step. Approve-link check (port 3457): GET /mock-approve/<order> → 302
  to /, fee APPROVED.
- One fix found during E2E: the mock approve link initially pointed at a
  non-existent path; added `GET /mock-approve/:orderId` and the server now
  builds the link with the real host. Re-verified after the fix; tests
  re-run green.
- No credentials were created, used, or stored. No money spent. No public
  repo or Devpost submission made. No other project touched.

### Still needs Krupal (in order)

1. PayPal Developer sandbox account + app → Client ID + Secret into `.env`
   (README step 3). Only he can do this.
2. A public URL for the server (deploy or tunnel), then webhook
   registration in the PayPal app → `PAYPAL_WEBHOOK_ID`.
3. Live sandbox demo run (Slice 2–3): real payer approval + capture +
   verified webhook flipping a fee to SETTLED.
4. Public GitHub repo, demo video (< 3 min), Devpost submission — deadline
   Fri 13 Nov 2026, 01:30 IST.

## 2026-10-26 ~17:50 IST — Public repo + live deploy attempt

### 1. Public GitHub repo `feedesk-ai` — BLOCKED (credentials)
- `github call-tool create_repository {name: feedesk-ai, private: false}` → **403 "Resource not accessible by integration"**. The GitHub MCP connection is a GitHub App integration token: it can push to repos where the app is installed (verified: works on krupalsai/Job-hunt) but it CANNOT create new user-owned repos.
- Checked alternatives: `custom.github` token (gh-api.py) → 401 Bad credentials (dead); `gh` CLI → not logged in; OAuth re-authorize → refused ("already connected; disconnect it before starting a new authorization flow" — disconnecting risks the working Job-hunt push route, so NOT done).
- No `.env` exists in the project (verified — only `.env.example`); all 19 files are plain text and push-ready.
- UNBLOCK (30 seconds, Krupal): create the empty public repo at https://github.com/new — name `feedesk-ai`, public, no README/license — then run:
  `cd ~/workspace/hackathons/paypal-ai && printf '%s\0' .env.example .gitignore BUILD-LOG.md LICENSE README.md ai/explain.js docs/scope.md lib/store.js package.json paypal/client.js paypal/mock.js public/index.html samples/webhook-capture-completed.json samples/webhook-capture-denied.json samples/webhook-capture-pending.json samples/webhook-capture-refunded.json samples/webhook-order-approved.json server.js test/mock-flow.js test/smoke.js > /tmp/feedesk-paths && /opt/hatch/bin/github push-files --owner krupalsai --repo feedesk-ai --branch main --message "FeeDesk AI: mock-mode build complete (PayPal AI Hackathon)" --source-dir ~/workspace/hackathons/paypal-ai --paths-file /tmp/feedesk-paths`
- README stays honest: mock-mode build complete + verified; live PayPal pending Krupal's sandbox credentials.

### 2. Server deploy on Oracle VM `voice-server` — RUNNING, tailnet-only
- Code copied to `/home/ubuntu/feedesk-ai` (scp via Tailscale proxy). No `.env` on the VM. Node v20.20.2.
- Service: systemd user unit `~/.config/systemd/user/feedesk-ai.service` — `PAYPAL_MODE=mock`, `PORT=3000`, `Restart=always`, logs to `~/feedesk-ai/feedesk.log`. Enabled + `loginctl enable-linger ubuntu` (Linger=yes) so it survives logout/reboot. Status: **active (running)**, ~18 MB RAM. Voice media server on :8080 untouched.
- Reachable inside the tailnet: `http://100.66.182.66:3000/` → 200, `/fees` → `{"mode":"mock","count":0,"fees":[]}`.
- **NOT publicly reachable — BLOCKED by OCI security list.** Probed from this machine, public IP 129.225.83.114: ports 3000, 3001, 5000, 7000, 8000, 8081, 9000, 80, 443 all time out (000). Only :8080 (media server, 404 on /) and :22 answer. Timeouts (not immediate rejects) = packets dropped at the OCI security-list level before reaching the VM.
- UNBLOCK (Krupal, OCI console): in the VM's subnet security list, add an ingress rule allowing TCP on port 3000 from 0.0.0.0/0. After that, the public URL is `http://129.225.83.114:3000/` (desk) and the webhook endpoint `http://129.225.83.114:3000/webhook`. No new hosting accounts were created (per instructions).
- Note: public URL would be plain HTTP on :3000. For PayPal webhook registration PayPal accepts HTTP for sandbox webhooks; HTTPS would need a reverse proxy + cert later (not done).

### Still needs Krupal (in order)
1. Create empty public repo `feedesk-ai` on GitHub (see above) → push follows immediately.
2. OCI console: open TCP 3000 ingress → public URL live.
3. PayPal Developer sandbox account + Client ID/Secret into `.env` → live mode + webhook registration → Devpost submit (deadline 13 Nov 2026 01:30 IST).
