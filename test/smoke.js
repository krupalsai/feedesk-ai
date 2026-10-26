// test/smoke.js — no-credentials smoke test for the FeeDesk AI scaffold.
//
// Spawns server.js on a test port with PayPal credentials DELIBERATELY REMOVED
// from the environment, then checks:
//   1. GET / serves the desk page.
//   2. POST /create-order fails GRACEFULLY (503, code PAYPAL_CREDENTIALS_MISSING).
//   3. POST /webhook accepts the sample PAYMENT.CAPTURE.COMPLETED payload,
//      answers 200, and the server logs the event type.
//   4. POST /explain-status returns a plain-language explanation of the sample.
// Run: npm run smoke

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3100 + Math.floor(Math.random() * 400);
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

// Strip any real credentials so the test always exercises the no-creds path.
const env = { ...process.env, PORT: String(PORT) };
delete env.PAYPAL_CLIENT_ID;
delete env.PAYPAL_CLIENT_SECRET;
delete env.PAYPAL_WEBHOOK_ID;
env.PAYPAL_ENV = "sandbox";

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
  console.log(`Smoke test against ${base} (credentials intentionally unset)\n`);
  check("server starts", await waitForServer());

  // 1. Desk page
  const home = await fetch(`${base}/`);
  const homeText = await home.text();
  check("GET / serves desk page", home.status === 200 && homeText.includes("FeeDesk AI"));

  // 2. create-order with no credentials → graceful 503
  const create = await fetch(`${base}/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payerName: "Test Student", label: "Term 1 tuition fee", amount: "500.00", currency: "USD" }),
  });
  const createBody = await create.json();
  check(
    "POST /create-order without credentials fails gracefully",
    create.status === 503 &&
      createBody?.error?.code === "PAYPAL_CREDENTIALS_MISSING" &&
      /credentials are not configured/i.test(createBody?.error?.message || ""),
    `status=${create.status} code=${createBody?.error?.code}`
  );

  // 3. Webhook accepts + logs the sample payload
  const sampleRaw = await readFile(path.join(root, "samples", "webhook-capture-completed.json"), "utf8");
  const hook = await fetch(`${base}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: sampleRaw,
  });
  const hookBody = await hook.json();
  await new Promise((r) => setTimeout(r, 150)); // let stdout flush
  check(
    "POST /webhook accepts sample PAYMENT.CAPTURE.COMPLETED",
    hook.status === 200 && hookBody.received === true && hookBody.eventType === "PAYMENT.CAPTURE.COMPLETED",
    `status=${hook.status} eventType=${hookBody.eventType}`
  );
  check(
    "server logged the webhook event",
    serverLog.includes("[webhook] PAYMENT.CAPTURE.COMPLETED")
  );
  const events = await (await fetch(`${base}/webhook-events`)).json();
  check("GET /webhook-events recorded the event", events.count === 1);

  // 4. AI explainer answers for the same payload
  const explain = await fetch(`${base}/explain-status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: JSON.parse(sampleRaw) }),
  });
  const explainBody = await explain.json();
  check(
    "POST /explain-status explains the payment in plain language",
    explain.status === 200 &&
      /settled/i.test(explainBody?.explanation?.headline || "") &&
      (explainBody?.explanation?.source === "rules-fallback" || explainBody?.explanation?.source === "llm"),
    `headline="${explainBody?.explanation?.headline}" source=${explainBody?.explanation?.source}`
  );
  // 5. Mock-only routes refuse to run in live mode
  const mockApprove = await fetch(`${base}/mock/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: "MOCK-ORDER-0001" }),
  });
  const mockApproveBody = await mockApprove.json();
  check(
    "POST /mock/approve in live mode is refused (MOCK_ONLY)",
    mockApprove.status === 400 && mockApproveBody?.error?.code === "MOCK_ONLY",
    `status=${mockApprove.status} code=${mockApproveBody?.error?.code}`
  );
} catch (err) {
  failed++;
  console.log(`  FAIL  unexpected error — ${err.message}`);
} finally {
  server.kill("SIGTERM");
}

console.log(`\nSmoke test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
