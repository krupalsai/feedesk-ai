// server.js — FeeDesk AI entry point (zero-dependency Node http server).
//
// Modes:
//   PAYPAL_MODE=mock  → local simulation: no credentials, no network, no
//                        real money. Mock payer buttons on the desk approve
//                        and capture orders; mock webhooks are HMAC-signed
//                        and verified like real ones.
//   anything else     → live PayPal sandbox (default) or live APIs; needs
//                        PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in the
//                        environment. Without them, payment routes answer 503.
//
// Routes:
//   GET  /                → desk page (public/index.html)
//   GET  /health          → { ok, mode, llm }
//   GET  /fees            → fee ledger (status comes only from verified
//                           PayPal facts — capture responses + webhooks)
//   GET  /fees/:feeId     → one fee with its event history + explanation
//   POST /create-order    → create a fee + PayPal order (mock or live)
//   POST /mock/approve    → mock only: simulate the payer approving an order
//   POST /capture-order   → capture an approved order; mock mode accepts
//                           { mockOutcome: completed|pending|denied|refunded }
//   POST /mock/refund     → mock only: simulate a refund of a settled fee
//   POST /webhook         → PayPal webhooks: verify signature + update ledger
//   GET  /webhook-events  → every webhook received (verified + unverified)
//   POST /explain-status  → AI explainer: PayPal event JSON → plain language
//   POST /fees/:feeId/explain → explain the fee's latest event, stored on it
//
// Run: node server.js   (PORT env var, default 3000)

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOrder,
  captureOrder,
  verifyWebhookSignature,
  paypalMode,
  isMockMode,
  PayPalConfigError,
} from "./paypal/client.js";
import {
  mockApproveEvent,
  mockCapture,
  mockRefundEvent,
  signMockWebhook,
} from "./paypal/mock.js";
import { explainPaymentEvent, llmStatus } from "./ai/explain.js";
import {
  createFee,
  getFee,
  listFees,
  findFeeByOrderId,
  attachOrder,
  applyCaptureResponse,
  applyWebhookEvent,
  setExplanation,
  listWebhookEvents,
} from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MODE = paypalMode();

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

function handlePayPalError(res, err) {
  if (err instanceof PayPalConfigError || err.code === "PAYPAL_CREDENTIALS_MISSING") {
    return sendJson(res, 503, {
      error: { code: err.code, message: err.message },
    });
  }
  console.error("[paypal] API error:", err.message, err.paypalBody || "");
  return sendJson(res, 502, {
    error: {
      code: "PAYPAL_API_ERROR",
      message: err.message,
      paypal: err.paypalBody || undefined,
    },
  });
}

// Shared webhook processing: verify the signature, record the event, and let
// the ledger update the fee — but ONLY if verification passed. Used both by
// the public /webhook route and by the mock engine (which delivers its
// signed events through this same function).
async function processWebhook(headers, rawBody) {
  const event = JSON.parse(rawBody);
  const verification = await verifyWebhookSignature(headers, rawBody);
  const { fee, applied, record } = applyWebhookEvent(event, verification);
  console.log(
    `[webhook] ${record.eventType} id=${record.eventId} resource=${record.resourceId} ` +
      `status=${record.resourceStatus} verified=${record.verified}` +
      (record.verificationSkipped ? " (verification skipped — no credentials/webhook id)" : "") +
      (applied && fee ? ` → fee ${fee.feeId} is now ${fee.status}` : "") +
      (!record.verified && !record.verificationSkipped ? " → UNVERIFIED, ignored for status" : "")
  );
  return { received: true, ...record, feeId: fee?.feeId || null, applied };
}

// Deliver a mock webhook event through the same verified pipeline as a real
// one: sign it with the mock HMAC scheme, then process it.
async function deliverMockWebhook(event) {
  const rawBody = JSON.stringify(event);
  const headers = signMockWebhook(rawBody);
  return processWebhook(headers, rawBody);
}

function publicFee(fee) {
  return fee;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(path.join(__dirname, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        app: "feedesk-ai",
        mode: MODE,
        llm: llmStatus(),
      });
    }

    // GET /fees — the desk ledger.
    if (req.method === "GET" && url.pathname === "/fees") {
      return sendJson(res, 200, { mode: MODE, count: listFees().length, fees: listFees() });
    }

    // GET /fees/:feeId
    const feeMatch = url.pathname.match(/^\/fees\/([A-Za-z0-9-]+)$/);
    if (req.method === "GET" && feeMatch) {
      const fee = getFee(feeMatch[1]);
      if (!fee) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No fee ${feeMatch[1]}.` } });
      return sendJson(res, 200, { fee: publicFee(fee) });
    }

    // POST /fees/:feeId/explain — explain the fee's latest event, store it.
    const explainMatch = url.pathname.match(/^\/fees\/([A-Za-z0-9-]+)\/explain$/);
    if (req.method === "POST" && explainMatch) {
      const fee = getFee(explainMatch[1]);
      if (!fee) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No fee ${explainMatch[1]}.` } });
      const last = [...fee.events].reverse().find((e) => e.type && e.type.startsWith("PAYMENT.")) ||
        fee.events[fee.events.length - 1];
      if (!last) {
        return sendJson(res, 400, {
          error: { code: "NOTHING_TO_EXPLAIN", message: "This fee has no PayPal event yet." },
        });
      }
      const event = listWebhookEvents().find((e) => e.eventType === last.type && e.resourceId === fee.captureId) ||
        listWebhookEvents().find((e) => e.eventType === last.type);
      const explanation = await explainPaymentEvent(event ? event.event : { event_type: last.type, resource: { status: last.status } });
      setExplanation(fee, explanation);
      return sendJson(res, 200, { feeId: fee.feeId, explanation });
    }

    // POST /create-order { payerName, label, amount, currency?, feeId? }
    // Creates the fee in the ledger AND the PayPal order, then links them.
    if (req.method === "POST" && url.pathname === "/create-order") {
      const body = await parseJsonBody(req);
      if (!body.amount || Number.isNaN(Number(body.amount)) || Number(body.amount) <= 0) {
        return sendJson(res, 400, {
          error: { code: "BAD_REQUEST", message: "amount is required and must be a positive number." },
        });
      }
      const fee = createFee({
        payerName: body.payerName,
        label: body.label || "Course fee",
        amount: body.amount,
        currency: body.currency || "USD",
      });
      const result = await createOrder({
        payerName: fee.payerName,
        label: fee.label,
        amount: fee.amount,
        currency: fee.currency,
        feeId: fee.feeId,
      });
      // In mock mode the approve link is a local route that simulates the
      // payer approving on PayPal and returning to the desk.
      if (isMockMode()) {
        result.approveUrl = `http://${req.headers.host}/mock-approve/${result.orderId}`;
      }
      attachOrder(fee, result);
      console.log(`[create-order] fee=${fee.feeId} order=${result.orderId} status=${result.status} mode=${MODE}`);
      return sendJson(res, 201, { fee: publicFee(fee), orderId: result.orderId, status: result.status, approveUrl: result.approveUrl });
    }

    // GET /mock-approve/:orderId — mock only: the "PayPal approve link".
    // Simulates the payer approving on PayPal, then returns to the desk.
    const approveLinkMatch = url.pathname.match(/^\/mock-approve\/([A-Za-z0-9-]+)$/);
    if (req.method === "GET" && approveLinkMatch) {
      if (!isMockMode()) {
        return sendJson(res, 400, {
          error: { code: "MOCK_ONLY", message: "This route only exists in PAYPAL_MODE=mock." },
        });
      }
      const event = mockApproveEvent(approveLinkMatch[1]);
      if (!event) {
        return sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No mock order ${approveLinkMatch[1]}.` } });
      }
      await deliverMockWebhook(event);
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    // POST /mock/approve { orderId } — mock only: the test payer approves.
    if (req.method === "POST" && url.pathname === "/mock/approve") {
      if (!isMockMode()) {
        return sendJson(res, 400, {
          error: { code: "MOCK_ONLY", message: "This route only exists in PAYPAL_MODE=mock." },
        });
      }
      const body = await parseJsonBody(req);
      if (!body.orderId) {
        return sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "orderId is required." } });
      }
      const event = mockApproveEvent(body.orderId);
      if (!event) {
        return sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No mock order ${body.orderId}.` } });
      }
      const delivered = await deliverMockWebhook(event);
      const fee = findFeeByOrderId(body.orderId);
      return sendJson(res, 200, { approved: true, feeId: fee?.feeId || null, feeStatus: fee?.status || null, webhook: delivered });
    }

    // POST /capture-order { orderId, mockOutcome? }
    // mockOutcome (mock mode only): completed | pending | denied | refunded.
    if (req.method === "POST" && url.pathname === "/capture-order") {
      const body = await parseJsonBody(req);
      if (!body.orderId) {
        return sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "orderId is required." } });
      }
      const fee = findFeeByOrderId(body.orderId);
      if (isMockMode()) {
        const outcome = body.mockOutcome || "completed";
        let result;
        try {
          result = mockCapture(body.orderId, outcome);
        } catch (err) {
          return sendJson(res, 400, { error: { code: "BAD_REQUEST", message: err.message } });
        }
        if (!result) {
          return sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No mock order ${body.orderId}.` } });
        }
        if (fee) applyCaptureResponse(fee, result.capture);
        const delivered = await deliverMockWebhook(result.event);
        let followUp = null;
        if (result.followUpEvent) followUp = await deliverMockWebhook(result.followUpEvent);
        console.log(`[capture-order] mock order=${body.orderId} outcome=${outcome} fee=${fee?.feeId} status=${fee?.status}`);
        return sendJson(res, 200, {
          fee: fee ? publicFee(fee) : null,
          capture: result.capture,
          webhook: delivered,
          followUpWebhook: followUp,
        });
      }
      const result = await captureOrder(body.orderId);
      if (fee) applyCaptureResponse(fee, result);
      console.log(`[capture-order] order=${body.orderId} status=${result.status}`);
      return sendJson(res, 200, { fee: fee ? publicFee(fee) : null, capture: result });
    }

    // POST /mock/refund { orderId } — mock only: refund a settled fee.
    if (req.method === "POST" && url.pathname === "/mock/refund") {
      if (!isMockMode()) {
        return sendJson(res, 400, {
          error: { code: "MOCK_ONLY", message: "This route only exists in PAYPAL_MODE=mock." },
        });
      }
      const body = await parseJsonBody(req);
      if (!body.orderId) {
        return sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "orderId is required." } });
      }
      const event = mockRefundEvent(body.orderId);
      if (!event) {
        return sendJson(res, 404, {
          error: { code: "NOT_FOUND", message: `No captured mock order ${body.orderId} to refund.` },
        });
      }
      const delivered = await deliverMockWebhook(event);
      const fee = findFeeByOrderId(body.orderId);
      return sendJson(res, 200, { refunded: true, feeId: fee?.feeId || null, feeStatus: fee?.status || null, webhook: delivered });
    }

    // POST /webhook — PayPal sends payment events here.
    if (req.method === "POST" && url.pathname === "/webhook") {
      const raw = await readBody(req);
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, {
          error: { code: "BAD_JSON", message: "Webhook body was not valid JSON." },
        });
      }
      void event;
      const result = await processWebhook(req.headers, raw);
      // PayPal expects a 200; anything else triggers retries.
      return sendJson(res, 200, result);
    }

    // GET /webhook-events — what the desk has heard from PayPal (demo aid).
    if (req.method === "GET" && url.pathname === "/webhook-events") {
      return sendJson(res, 200, { count: listWebhookEvents().length, events: listWebhookEvents() });
    }

    // POST /explain-status { event: <PayPal event or capture response> }
    if (req.method === "POST" && url.pathname === "/explain-status") {
      const body = await parseJsonBody(req);
      if (!body.event) {
        return sendJson(res, 400, {
          error: { code: "BAD_REQUEST", message: "event is required." },
        });
      }
      const explanation = await explainPaymentEvent(body.event);
      return sendJson(res, 200, { explanation });
    }

    return sendJson(res, 404, {
      error: { code: "NOT_FOUND", message: `No route for ${req.method} ${url.pathname}` },
    });
  } catch (err) {
    if (err instanceof PayPalConfigError || err.code === "PAYPAL_CREDENTIALS_MISSING" || err.paypalBody) {
      return handlePayPalError(res, err);
    }
    console.error("[server] error:", err);
    return sendJson(res, 500, {
      error: { code: "INTERNAL", message: err.message || "Unexpected server error." },
    });
  }
});

server.listen(PORT, () => {
  console.log(`FeeDesk AI listening on http://localhost:${PORT} (mode=${MODE})`);
});
