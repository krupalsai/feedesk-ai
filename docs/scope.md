# FeeDesk AI — Scope & Build Plan

**Event:** PayPal AI Hackathon (Devpost challenge 31302)
**Deadline:** Nov 13, 2026, 01:30 IST — Devpost submission must be in before this.
**Builder:** Solo — Sai Krupal Kusanapelli (registered on Devpost as `krupalsai`)
**Build window:** Oct 28 – Nov 10, 2026 (this document + scaffold were prepared ahead of the window; no PayPal account or credentials exist yet)

---

## 1. Concept

FeeDesk AI is a small fee-collection desk for a coaching institute / small training business:

- **Staff** create a fee payment order (student name, fee label, amount) from a simple desk page.
- The **payer** (student/parent) pays through **PayPal Sandbox checkout**.
- PayPal **webhooks** are the source of truth: when a capture completes, is denied, or goes pending, the desk records it — staff never have to trust a screenshot of a "paid" screen.
- An **AI assistant** reads the raw PayPal event payload and explains, in plain language, **what happened, why, and what staff should do next** ("Payment captured — fee settled, no action needed" / "Capture denied — card refused by the issuer; ask the payer for a different payment method, do not mark the fee as paid").

Why this concept: it is a thin, honest slice of a real problem Krupal has already operated — his Student Platform collects student fees and verifies payments via payment-gateway webhooks for 150+ students. FeeDesk AI re-builds that verification loop on PayPal's sandbox rails and adds the AI explanation layer the hackathon asks for. It is deliberately small: one desk page, three server routes, one AI function.

## 2. User flow

1. Staff open the desk page (`/`), enter payer name, fee label, amount → **Create payment order**.
2. Server calls PayPal **Create Order** → returns an approve link / order id. Desk shows "Waiting for payment" with the link.
3. Payer opens the link, logs in with a **PayPal sandbox personal account**, approves the payment.
4. Staff click **Capture** (or the desk auto-captures after approval) → server calls **Capture Order**.
5. PayPal fires webhooks (`PAYMENT.CAPTURE.COMPLETED` / `DENIED` / `PENDING`). The `/webhook` route verifies the signature, logs the event, and updates the payment's status on the desk.
6. Staff click **Explain** on any payment → the AI assistant turns the stored PayPal event payload into a plain-language explanation + next step, shown on the desk.
7. A payment is only shown as **"Fee settled"** when a verified `PAYMENT.CAPTURE.COMPLETED` webhook (or a completed capture response) exists — never from the payer's word or a screenshot.

## 3. PayPal platform usage (exact APIs & webhooks)

All calls go to the sandbox base URL `https://api-m.sandbox.paypal.com` while `PAYPAL_ENV=sandbox`. Credentials come only from environment variables (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) — nothing is hardcoded.

| Purpose | API |
|---|---|
| Access token | `POST /v1/oauth2/token` (client-credentials grant) |
| Create fee order | `POST /v2/checkout/orders` (`intent: CAPTURE`, one purchase unit, `custom_id` = internal fee id) |
| Capture after approval | `POST /v2/checkout/orders/{order_id}/capture` |
| Look up an order | `GET /v2/checkout/orders/{order_id}` (status reconciliation) |
| Verify webhook signature | `POST /v1/notifications/verify-webhook-signature` (with `PAYPAL_WEBHOOK_ID`) |

Browser side (Slice 2): PayPal **JavaScript SDK** smart buttons on the desk page call the server's `/create-order` and `/capture-order` routes — the standard PayPal checkout quickstart pattern.

**Webhook events subscribed:**

- `CHECKOUT.ORDER.APPROVED` — payer approved; desk prompts capture.
- `PAYMENT.CAPTURE.COMPLETED` — money captured; fee marked settled.
- `PAYMENT.CAPTURE.PENDING` — captured but pending (e.g., review/eCheck); AI explains the wait.
- `PAYMENT.CAPTURE.DENIED` — capture refused; AI explains likely reasons + next step.
- `PAYMENT.CAPTURE.REFUNDED` — a refund happened; desk flags the fee as reopened.

## 4. AI component

- **Job:** translate one PayPal payment event (capture response or webhook payload) into staff-ready language. Raw PayPal payloads are JSON full of codes (`status: DECLINED`, reason codes, processor response codes) that a fee-desk operator cannot act on; the AI turns them into a decision.
- **Input:** the PayPal event JSON (event type, status, amount, payer, failure/reason fields) + a fixed instruction prompt (defined in `ai/explain.js` as `EXPLANATION_PROMPT`).
- **Output:** a short JSON object — `{ headline, explanation, next_step, confidence_note }` — e.g. headline "Payment failed — do not mark fee as paid".
- **Status in scaffold:** the prompt and interface are defined; the LLM call is stubbed. Until a model key is wired (Slice 4), `ai/explain.js` returns a deterministic rule-based explanation derived from the event type/status so the demo flow works end-to-end. Wiring the real LLM is a one-function change.
- **AI tools disclosure (for Devpost):** to be finalised at submission — will list the LLM used for explanations and any AI assistance used while building, per hackathon rules.

## 5. What "meaningfully uses PayPal + AI" means here (judging lens)

- **PayPal is the payment rail, not a logo.** Orders are created, approved, and captured through PayPal's Orders API; webhooks — signature-verified — decide the fee's status. Remove PayPal and there is no product: no money moves and nothing is verified.
- **AI does work a human would otherwise do.** Reading gateway payloads and deciding "is this fee actually settled, and if not, what do I do?" is the daily judgement call of a fee desk. The AI makes that call explainable to non-technical staff. Remove the AI and staff are back to decoding raw JSON and status codes.
- **The two halves meet in one loop:** PayPal event → AI explanation → staff action. Neither half is decorative; the submission demo will show a completed payment, a pending payment, and a denied payment, each with its AI explanation.

## 6. Stack choice — why Node

The scaffold is **Node (zero-dependency: built-in `http` + global `fetch`)**:

- PayPal's Orders API quickstart and the JavaScript SDK are Node/browser-first; the canonical server-side examples are Node.
- It matches Krupal's existing stack (his Student Platform is Next.js/Node), so every line is explainable by him in judging Q&A.
- Zero npm dependencies means the scaffold runs and smoke-tests anywhere with `node server.js` — no install step can break before the build window opens.

## 7. Build slices (Oct 28 – Nov 10)

Each slice is small and has a hard done-definition. Slices are sized to protect TS SI exam prep (prelims Nov 29) — this is the side track.

| Slice | Dates | Work | Done when |
|---|---|---|---|
| 1 — Sandbox live | Oct 28–29 | Krupal creates PayPal Developer sandbox account + app; credentials into `.env`; token + create-order round trip from the scaffold | `POST /create-order` returns a real sandbox order id + approve link |
| 2 — Checkout + capture | Oct 30–31 | PayPal JS SDK buttons on the desk page wired to `/create-order` + `/capture-order` | A sandbox personal-account payer completes a payment; capture response shows `COMPLETED` |
| 3 — Webhooks verified | Nov 1–3 | Public URL for the server (deploy or tunnel), webhook created in the PayPal app, signature verification on, events logged to a local store | A real `PAYMENT.CAPTURE.COMPLETED` webhook arrives, verifies, and flips the desk status to "Fee settled" |
| 4 — AI wired | Nov 4–6 | Replace the explainer stub with a real LLM call using `EXPLANATION_PROMPT`; keep rule-based fallback | Completed, pending, and denied sample events each produce a correct plain-language explanation + next step |
| 5 — Desk polish + failure demo | Nov 7–8 | Payment list with statuses + explanations; rehearse the denied/pending demos | Full demo script (pay → settle; pay → denied; pending) runs clean end-to-end twice |
| 6 — Submission pack | Nov 9–10 | Final README (setup + run), public GitHub repo + MIT LICENSE (already in scaffold), record demo video < 3 min, fill Devpost project page incl. AI-tools list | Devpost submission submitted — 3 days before the Nov 13, 01:30 IST deadline |

## 8. Risks

- **Sandbox account friction** — developer account/app creation is a manual step only Krupal can do; if it stalls, Slices 2+ slip. Mitigation: it's Slice 1, on day one of the window.
- **Webhooks need a public URL** — localhost can't receive PayPal webhooks. Mitigation: free tunnel or a small deploy; decided in Slice 3, and capture-response polling (`GET order`) is the fallback proof of status.
- **Currency/account limits in sandbox** — default the demo to USD in sandbox (`.env.example` notes this); INR behaviour depends on sandbox account setup and is not on the critical path.
- **LLM key/cost** — explainer must work without a paid key: rule-based fallback already in the scaffold; any free-tier LLM is enough for Slice 4.
- **Time** — solo builder, exam on Nov 29. The scope is frozen at one desk page + three routes + one AI function; anything beyond that is cut, not deferred.
- **"Mockup" disqualification** — rules require a functional demo. Everything above runs against the real PayPal sandbox; no fake payment screens anywhere in the demo.

## 9. Submission checklist (Devpost, challenge 31302)

- [ ] Working demo: hosted URL **or** repo with exact run instructions (README covers both paths)
- [ ] Meaningful PayPal use: Orders API create/capture + verified webhooks (Slices 1–3)
- [ ] Meaningful AI use: event explainer wired to a real LLM (Slice 4)
- [ ] Public code repository with visible license file (MIT LICENSE already in scaffold)
- [ ] Text description of the project (from §1 + §5 of this document)
- [ ] List of AI tools used and how (explainer model + build assistance — finalised honestly at submission)
- [ ] Demo video < 3 minutes, public (YouTube) — recorded in Slice 6
- [ ] Submitted before **Nov 13, 2026, 01:30 IST**
