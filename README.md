# FeeDesk AI

A fee-collection desk for a small coaching institute, built on the **PayPal Sandbox**
with an **AI payment explainer** — created for the **PayPal AI Hackathon**
(Devpost challenge 31302, submission deadline **Nov 13, 2026, 01:30 IST**).

**What it does**

1. Staff create a fee payment order from a simple desk page.
2. The payer pays through PayPal Sandbox checkout (Orders API).
3. PayPal webhooks — signature-verified — decide whether a fee is truly settled.
   No trusting screenshots.
4. An AI assistant reads each PayPal event payload and explains, in plain
   language, what happened, why, and what staff should do next.

Full design, API list, build plan, and judging notes: [`docs/scope.md`](docs/scope.md).

> **Status: mock-mode build complete and verified (2026-10-26).** The full
> loop runs end to end with no credentials: create a fee → mock payer
> approves → capture (succeed / pending / denied / refunded) → HMAC-signed
> mock webhook verified → fee status flips → AI explainer answers in plain
> language. `npm test` passes 36/36 (8 smoke + 28 mock-flow). The live
> PayPal path is code-complete but inert without credentials. **Not done
> yet:** real PayPal Sandbox credentials + webhook registration (only Krupal
> can do this from his PayPal Developer account), public repo, demo video,
> Devpost submission.

## Stack

Node ≥ 18, **zero npm dependencies** (built-in `http` + global `fetch`), so it
runs anywhere with `node server.js`.

## Setup

### 1. Clone and check

```bash
git clone <this-repo> feedesk-ai
cd feedesk-ai
node --version   # must be >= 18
```

No `npm install` needed — there are no dependencies.

### 2. Create your env file

```bash
cp .env.example .env
```

### 3. ★ KRUPAL — create the PayPal Developer sandbox account + app ★

**This step is manual and only you can do it** (it is tied to your PayPal
account). It is the one remaining blocker for the live sandbox demo:

1. Go to the PayPal Developer portal and sign in / sign up with your own
   PayPal account.
2. In **Apps & Credentials**, switch to the **Sandbox** tab and create an app
   (any name, e.g. "FeeDesk AI").
3. Copy the app's **Client ID** and **Secret** into `.env`:

   ```
   PAYPAL_CLIENT_ID=<your sandbox client id>
   PAYPAL_CLIENT_SECRET=<your sandbox secret>
   PAYPAL_ENV=sandbox
   ```

4. In the same portal, note the auto-created **sandbox accounts** — a business
   account (the institute) and a personal account (the test payer). You will
   use the personal account to "pay" fees during demos. **No real money is
   ever involved in sandbox.**
5. Later (Slice 3), after the server has a public URL, register a webhook in
   the app pointing at `<public-url>/webhook` for the events listed in
   `docs/scope.md`, and put the resulting webhook id in `.env` as
   `PAYPAL_WEBHOOK_ID=`.

> Never paste credentials into code, chat, or the repo. `.env` is gitignored.

### 4. Run

```bash
node server.js
# FeeDesk AI listening on http://localhost:3000 (mode=mock)
```

Open <http://localhost:3000> for the desk page. In mock mode the desk shows
a yellow banner and the fee table has buttons to simulate the payer
(approve) and the outcome of the capture (succeeds / pending / denied /
paid-then-refunded), plus an **Explain** button on every fee that has a
PayPal event. Every fee's status comes only from verified PayPal facts —
a capture response or a verified webhook — never from a screenshot.

To run against the real sandbox instead, set `PAYPAL_MODE=live` (or unset
it) in `.env` after completing step 3. Without credentials the payment
routes answer 503 with a clear message; nothing is faked.

### 5. Tests (work with NO credentials)

```bash
npm test
```

Runs the smoke test (live mode, credentials deliberately unset: graceful
503s, webhook logging, explainer) and the mock-flow test (mock mode: order
creation, webhook signature valid + tampered, all four settlement
transitions, explainer output for every event type). 36 checks, all must
pass.

## Routes

| Route | What it does |
|---|---|
| `GET /` | Desk page |
| `POST /create-order` | Body `{ payerName, label, amount, currency?, feeId? }` → PayPal Create Order; returns order id + approve URL |
| `POST /capture-order` | Body `{ orderId }` → PayPal Capture Order |
| `POST /webhook` | Receives PayPal webhooks; verifies signature when `PAYPAL_WEBHOOK_ID` + credentials exist; logs every event; always answers 200 |
| `GET /health` | `{ ok, mode, llm }` — mode is `mock` or `live`; `llm` says whether a model key is configured (never the key) |
| `GET /fees` | Fee ledger: every fee with its settlement status, order id, event history and latest explanation |
| `GET /fees/:feeId` | One fee |
| `POST /fees/:feeId/explain` | Explain the fee's latest PayPal event in plain language; stored on the fee |
| `POST /mock/approve` | Mock only: simulate the payer approving an order |
| `GET /mock-approve/:orderId` | Mock only: the "PayPal approve link" — approves, then returns to the desk |
| `POST /mock/refund` | Mock only: simulate a refund of a settled fee |
| `POST /explain-status` | Body `{ event: <PayPal event JSON> }` → AI explanation `{ headline, explanation, next_step }` |

## AI explainer

`ai/explain.js` defines the full prompt (`EXPLANATION_PROMPT`) and the
`explainPaymentEvent(event)` interface. It answers in two ways:

- **Rule-based (default, always works, no key):** a deterministic explainer
  derives headline + explanation + next step from the event type/status.
  This is what the demo uses.
- **LLM (optional enhancement):** if `GROQ_API_KEY` is set, the prompt goes
  to Groq (free tier); else if `GEMINI_API_KEY` is set, it goes to Gemini.
  The model must return the JSON from the prompt; any failure (timeout, bad
  key, bad JSON) falls back to the rule-based answer silently. The response
  carries `source: "llm"` or `source: "rules-fallback"` so the desk always
  shows which one answered.

## Not done yet (needs Krupal)

- **PayPal Developer sandbox account + app** → `PAYPAL_CLIENT_ID` /
  `PAYPAL_CLIENT_SECRET` in `.env` (README step 3). Without this, only mock
  mode works; the live path is code-complete but inert.
- **Webhook registration** (needs a public URL for the server first, then
  register `<public-url>/webhook` in the PayPal app) → `PAYPAL_WEBHOOK_ID`.
  Until then, live webhooks cannot arrive; capture-response polling
  (`GET /v2/checkout/orders/{id}`) is the fallback proof of status.
- **Demo video (< 3 min)** + **Devpost submission**
  (deadline Nov 13, 2026, 01:30 IST). Repo is public at
  https://github.com/krupalsai/feedesk-ai.
- **PayPal JS SDK smart buttons** on the desk page (Slice 2) — the desk
  currently calls `/create-order` + `/capture-order` directly; the payer
  flow in live mode uses the approve link. SDK buttons are a polish item,
  not a blocker.

## Project layout

```
server.js               entry point + routes (fees, mock payer flow, webhooks)
paypal/client.js        Orders API client (live) + mock-mode dispatch
paypal/mock.js          mock PayPal engine: orders, captures, webhook events,
                        HMAC signing/verification (mock only, never real)
lib/store.js            fee ledger: settlement statuses, webhook event log
ai/explain.js           explainer prompt + rules fallback + optional LLM
                        (Groq, then Gemini — inert without a key)
public/index.html       desk page: create fee, fee table, mock controls,
                        explanations, webhook event log
samples/                sample PayPal webhook payloads (completed, pending,
                        denied, refunded, order-approved)
test/smoke.js           no-credentials smoke test (live mode)
test/mock-flow.js       end-to-end mock tests: order creation, signature
                        valid + tampered, status transitions, explainer
docs/scope.md           concept, APIs, build slices, risks, submission checklist
BUILD-LOG.md            build log (what was built, when, what was verified)
```

## License

MIT — see [LICENSE](LICENSE).
