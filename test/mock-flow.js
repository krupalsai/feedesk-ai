// test/mock-flow.js — end-to-end tests for FeeDesk AI in PAYPAL_MODE=mock.
//
// Spawns server.js with PAYPAL_MODE=mock and NO credentials, then checks:
//   1. Order creation: fee is created in the ledger, mock order returned.
//   2. Webhook signature verification: valid mock signature verifies; a
//      tampered signature and a tampered body do NOT verify — and an
//      unverified webhook never changes a fee's status.
//   3. Settlement-status transitions for every outcome:
//      completed → SETTLED, pending → PENDING, denied → DENIED,
//      refunded → REFUNDED, approve → APPROVED.
//   4. AI explainer output for each event type (completed / pending /
//      denied / refunded / approved) — headline, explanation, next step.
//   5. Fee explain endpoint stores the explanation on the fee.
// Run: npm test  (runs smoke.js first, then this file)

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  signMockWebhook,
  verifyMockWebhookSignature,
} from "../paypal/mock.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3200 + Math.floor(Math.random() * 400);
const base = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { res, body: await res.json().catch(() => ({})) };
}

async function get(path) {
  const res = await fetch(`${base}${path}`);
  return { res, body: await res.json().catch(() => ({})) };
}

async function createFee(payerName, amount = "500.00") {
  const { res, body } = await post("/create-order", {
    payerName,
    label: "Term 1 tuition fee",
    amount,
    currency: "USD",
  });
  return { res, body };
}

async function feeStatus(feeId) {
  const { body } = await get(`/fees/${feeId}`);
  return body?.fee?.status;
}

// Server in mock mode, credentials deliberately absent, LLM keys absent.
const env = { ...process.env, PORT: String(PORT), PAYPAL_MODE: "mock" };
delete env.PAYPAL_CLIENT_ID;
delete env.PAYPAL_CLIENT_SECRET;
delete env.PAYPAL_WEBHOOK_ID;
delete env.GROQ_API_KEY;
delete env.GEMINI_API_KEY;

const server = spawn("node", [path.join(root, "server.js")], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

try {
  console.log(`Mock-flow test against ${base} (PAYPAL_MODE=mock, no credentials)\n`);
  check("server starts in mock mode", await waitForServer());
  const health = (await get("/health")).body;
  check("health reports mode=mock", health.mode === "mock", `mode=${health.mode}`);

  // --- 1. Order creation -----------------------------------------------
  const c1 = await createFee("Asha Verma");
  check(
    "POST /create-order creates a mock order + fee",
    c1.res.status === 201 &&
      c1.body.orderId?.startsWith("MOCK-ORDER-") &&
      c1.body.fee?.feeId?.startsWith("FEE-") &&
      c1.body.fee?.status === "AWAITING_APPROVAL",
    `orderId=${c1.body.orderId} feeId=${c1.body.fee?.feeId}`
  );
  const fee1 = c1.body.fee.feeId;
  const order1 = c1.body.orderId;
  const bad = await post("/create-order", { payerName: "X", amount: "0" });
  check("POST /create-order rejects a zero amount", bad.res.status === 400);
  const fees = (await get("/fees")).body;
  check("GET /fees lists the created fee", fees.count === 1 && fees.fees[0].feeId === fee1);

  // --- 2. Webhook signature verification (unit + HTTP) ------------------
  const raw = JSON.stringify({ event_type: "TEST", resource: { status: "COMPLETED" } });
  const headers = signMockWebhook(raw);
  check(
    "mock signature verifies (unit)",
    verifyMockWebhookSignature(headers, raw).verified === true
  );
  const tamperedHeaders = { ...headers, "paypal-transmission-sig": "0".repeat(64) };
  check(
    "tampered signature does NOT verify (unit)",
    verifyMockWebhookSignature(tamperedHeaders, raw).verified === false
  );
  check(
    "tampered body does NOT verify (unit)",
    verifyMockWebhookSignature(headers, raw + " ").verified === false
  );

  // HTTP-level: build a COMPLETED webhook for fee1's order, signed correctly
  // and tampered, and confirm only the valid one moves the fee.
  const completedEvent = {
    id: "WH-TEST-VALID-0001",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: "capture",
    resource: {
      id: "MOCK-CAPTURE-TEST-0001",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "500.00" },
      supplementary_data: { related_ids: { order_id: order1 } },
    },
  };
  const completedRaw = JSON.stringify(completedEvent);
  const goodHeaders = signMockWebhook(completedRaw);
  const tampered = await post("/webhook", completedRaw, {
    ...goodHeaders,
    "paypal-transmission-sig": "f".repeat(64),
  });
  check(
    "POST /webhook with a tampered signature answers 200 but verifies false",
    tampered.res.status === 200 && tampered.body.verified === false && tampered.body.applied === false,
    `verified=${tampered.body.verified}`
  );
  check(
    "unverified webhook does NOT change the fee status",
    (await feeStatus(fee1)) === "AWAITING_APPROVAL",
    `status=${await feeStatus(fee1)}`
  );
  const valid = await post("/webhook", completedRaw, goodHeaders);
  check(
    "POST /webhook with a valid signature verifies and applies",
    valid.res.status === 200 && valid.body.verified === true && valid.body.applied === true,
    `verified=${valid.body.verified} feeId=${valid.body.feeId}`
  );
  check(
    "verified COMPLETED webhook settles the fee",
    (await feeStatus(fee1)) === "SETTLED",
    `status=${await feeStatus(fee1)}`
  );

  // --- 3. Settlement-status transitions, full payer flow ----------------
  async function runFlow(payerName, outcome) {
    const c = await createFee(payerName);
    const feeId = c.body.fee.feeId;
    const orderId = c.body.orderId;
    const ap = await post("/mock/approve", { orderId });
    const approvedOk = ap.res.status === 200 && (await feeStatus(feeId)) === "APPROVED";
    const cap = await post("/capture-order", { orderId, mockOutcome: outcome });
    return { feeId, orderId, approvedOk, cap, finalStatus: await feeStatus(feeId) };
  }

  const fCompleted = await runFlow("Rahul Mehta", "completed");
  check(
    "flow completed: approve → APPROVED, capture → SETTLED",
    fCompleted.approvedOk && fCompleted.finalStatus === "SETTLED",
    `status=${fCompleted.finalStatus}`
  );
  const fPending = await runFlow("Sana Sheikh", "pending");
  check(
    "flow pending: capture pending → PENDING (not settled)",
    fPending.finalStatus === "PENDING",
    `status=${fPending.finalStatus}`
  );
  const fDenied = await runFlow("Imran Khan", "denied");
  check(
    "flow denied: capture denied → DENIED (not settled)",
    fDenied.finalStatus === "DENIED",
    `status=${fDenied.finalStatus}`
  );
  const fRefunded = await runFlow("Priya Nair", "refunded");
  check(
    "flow refunded: settled then refunded → REFUNDED",
    fRefunded.finalStatus === "REFUNDED",
    `status=${fRefunded.finalStatus}`
  );
  // Refund route on a settled fee
  const fSettled = await runFlow("Arjun Rao", "completed");
  const refund = await post("/mock/refund", { orderId: fSettled.orderId });
  check(
    "POST /mock/refund reopens a settled fee → REFUNDED",
    refund.res.status === 200 && (await feeStatus(fSettled.feeId)) === "REFUNDED",
    `status=${await feeStatus(fSettled.feeId)}`
  );
  const badOutcome = await post("/capture-order", { orderId: fSettled.orderId, mockOutcome: "bogus" });
  check("capture with an unknown mock outcome is rejected", badOutcome.res.status === 400);

  // --- 4. AI explainer output for each event type -----------------------
  const samples = [
    ["webhook-capture-completed.json", /settled/i, "Fee settled"],
    ["webhook-capture-pending.json", /pending/i, "Payment pending"],
    ["webhook-capture-denied.json", /not paid|failed/i, "Payment failed"],
    ["webhook-capture-refunded.json", /refund/i, "Payment refunded"],
    ["webhook-order-approved.json", /approved|approv/i, "Payer approved"],
  ];
  for (const [file, headlineRe, label] of samples) {
    const sampleRaw = await readFile(path.join(root, "samples", file), "utf8");
    const { res, body } = await post("/explain-status", { event: JSON.parse(sampleRaw) });
    const ex = body.explanation || {};
    check(
      `explainer: ${label} event → plain-language answer`,
      res.status === 200 &&
        headlineRe.test(ex.headline || "") &&
        typeof ex.explanation === "string" &&
        ex.explanation.length > 10 &&
        typeof ex.next_step === "string" &&
        ex.next_step.length > 0 &&
        ex.source === "rules-fallback",
      `headline="${ex.headline}" source=${ex.source}`
    );
  }

  // --- 5. Fee explain endpoint stores the explanation -------------------
  const { res: exRes, body: exBody } = await post(`/fees/${fCompleted.feeId}/explain`, {});
  check(
    "POST /fees/:id/explain explains the fee's latest event",
    exRes.status === 200 && /settled/i.test(exBody?.explanation?.headline || ""),
    `headline="${exBody?.explanation?.headline}"`
  );
  const feeAfter = (await get(`/fees/${fCompleted.feeId}`)).body.fee;
  check(
    "explanation is stored on the fee",
    feeAfter?.explanation?.headline === exBody?.explanation?.headline
  );
  const noEvents = await createFee("No Events Yet");
  const exEmpty = await post(`/fees/${noEvents.body.fee.feeId}/explain`, {});
  check(
    "explain on a fee with no events is a clean 400",
    exEmpty.res.status === 400 && exEmpty.body?.error?.code === "NOTHING_TO_EXPLAIN"
  );

  // Desk page + event log sanity
  const home = await fetch(`${base}/`);
  const homeText = await home.text();
  check("GET / serves the desk page", home.status === 200 && homeText.includes("FeeDesk AI"));
  const events = (await get("/webhook-events")).body;
  check("GET /webhook-events recorded verified + unverified events", events.count >= 10, `count=${events.count}`);
} catch (err) {
  failed++;
  console.log(`  FAIL  unexpected error — ${err.message}`);
  console.log(err.stack);
} finally {
  server.kill("SIGTERM");
}

console.log(`\nMock-flow test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
