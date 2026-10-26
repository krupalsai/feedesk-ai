// paypal/mock.js — Mock PayPal engine for FeeDesk AI.
//
// Used ONLY when PAYPAL_MODE=mock (no credentials, no network, no real
// money). It simulates the parts of PayPal the desk needs, with realistic
// payloads shaped like the real sandbox ones:
//   - create order  → order id MOCK-ORDER-xxxx, status CREATED, approve link
//   - payer approve → CHECKOUT.ORDER.APPROVED webhook event
//   - capture       → capture response + matching webhook event, with the
//                     outcome chosen by the caller (completed | pending |
//                     denied | refunded)
//   - refund        → PAYMENT.CAPTURE.REFUNDED webhook event
//
// Webhook signatures in mock mode are HMAC-SHA256 over
//   transmission_id + "|" + transmission_time + "|" + rawBody
// keyed by MOCK_WEBHOOK_SECRET (default: a fixed dev-only value). This is a
// DEMO-ONLY scheme so signature verification (valid + tampered) can be tested
// end to end. It is NOT PayPal's real verification and must never be used
// with real webhooks — live mode always calls PayPal's verify endpoint.

import crypto from "node:crypto";

export const MOCK_AUTH_ALGO = "MOCK-HMAC-SHA256";

export function mockWebhookSecret() {
  return process.env.MOCK_WEBHOOK_SECRET || "mock-secret-dev-only";
}

let orderCounter = 0;
let captureCounter = 0;
let eventCounter = 0;

// In-memory mock orders: orderId -> { id, status, fee, captureId }
const mockOrders = new Map();

function nextId(prefix) {
  return `${prefix}-${String(++orderCounter).padStart(4, "0")}-${Date.now()
    .toString(36)
    .toUpperCase()}`;
}

export function createMockOrder(fee) {
  const orderId = nextId("MOCK-ORDER");
  const order = {
    id: orderId,
    status: "CREATED",
    intent: "CAPTURE",
    feeId: fee.feeId || null,
    payerName: fee.payerName || null,
    label: fee.label || "Course fee",
    amount: { currency_code: (fee.currency || "USD").toUpperCase(), value: String(fee.amount) },
    links: [
      {
        href: `http://localhost/mock-approve/${orderId}`,
        rel: "approve",
        method: "GET",
      },
    ],
  };
  mockOrders.set(orderId, { ...order, captureId: null });
  return order;
}

export function getMockOrder(orderId) {
  return mockOrders.get(orderId) || null;
}

export function approveMockOrder(orderId) {
  const order = mockOrders.get(orderId);
  if (!order) return null;
  if (order.status !== "CREATED") return order;
  order.status = "APPROVED";
  return order;
}

function baseEvent(eventType, resource) {
  return {
    id: `WH-MOCK-${String(++eventCounter).padStart(4, "0")}-${Date.now().toString(36).toUpperCase()}`,
    event_type: eventType,
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: "capture",
    resource_version: "2.0",
    summary: mockSummary(eventType, resource),
    resource,
  };
}

function mockSummary(eventType, resource) {
  const amt = resource?.amount
    ? `${resource.amount.currency_code} ${resource.amount.value}`
    : "";
  switch (eventType) {
    case "CHECKOUT.ORDER.APPROVED":
      return `Checkout order approved for ${amt}`;
    case "PAYMENT.CAPTURE.COMPLETED":
      return `Payment completed for ${amt}`;
    case "PAYMENT.CAPTURE.PENDING":
      return `Payment pending for ${amt}`;
    case "PAYMENT.CAPTURE.DENIED":
      return `Payment denied for ${amt}`;
    case "PAYMENT.CAPTURE.REFUNDED":
      return `Payment refunded for ${amt}`;
    default:
      return `PayPal event ${eventType}`;
  }
}

function captureResource(order, status, extra = {}) {
  const amount = order.amount;
  return {
    id: `MOCK-CAPTURE-${String(++captureCounter).padStart(4, "0")}`,
    status,
    amount,
    final_capture: true,
    create_time: new Date().toISOString(),
    update_time: new Date().toISOString(),
    supplementary_data: {
      related_ids: { order_id: order.id },
    },
    ...extra,
  };
}

// Simulate a payer approving an order. Returns the CHECKOUT.ORDER.APPROVED
// webhook event the desk would receive from PayPal.
export function mockApproveEvent(orderId) {
  const order = approveMockOrder(orderId);
  if (!order) return null;
  const event = baseEvent("CHECKOUT.ORDER.APPROVED", {
    id: order.id,
    status: "APPROVED",
    amount: order.amount,
    supplementary_data: { related_ids: { order_id: order.id } },
  });
  event.resource_type = "checkout-order";
  return event;
}

// Simulate capturing an order. `outcome` is one of:
//   completed | pending | denied | refunded
// Returns { capture, event } where capture is the capture-order response
// (shaped like PayPal's) and event is the matching webhook payload.
// A denied capture has no successful capture: status DECLINED, no webhook
// capture id that settles anything — the DENIED webhook carries the denial.
export function mockCapture(orderId, outcome = "completed") {
  const order = mockOrders.get(orderId);
  if (!order) return null;
  const valid = ["completed", "pending", "denied", "refunded"];
  if (!valid.includes(outcome)) {
    throw new Error(`mockCapture: unknown outcome "${outcome}" (want one of ${valid.join(", ")})`);
  }
  if (order.status !== "APPROVED" && order.status !== "CREATED") {
    throw new Error(`mockCapture: order ${orderId} is ${order.status}, cannot capture.`);
  }

  if (outcome === "denied") {
    order.status = "DECLINED";
    const resource = captureResource(order, "DECLINED", {
      status_details: { reason: "PAYER_CANNOT_PAY" },
    });
    return {
      capture: {
        id: order.id,
        status: "DECLINED",
        purchase_units: [{ payments: { captures: [resource] } }],
      },
      event: baseEvent("PAYMENT.CAPTURE.DENIED", resource),
    };
  }

  const statusMap = { completed: "COMPLETED", pending: "PENDING", refunded: "COMPLETED" };
  const status = statusMap[outcome];
  const extra =
    outcome === "pending"
      ? { status_details: { reason: "PENDING_REVIEW" } }
      : outcome === "refunded"
        ? { seller_protection: { status: "ELIGIBLE" } }
        : { seller_protection: { status: "ELIGIBLE" } };
  const resource = captureResource(order, status, extra);
  order.status = "COMPLETED";
  order.captureId = resource.id;

  const capture = {
    id: order.id,
    status: "COMPLETED",
    purchase_units: [{ payments: { captures: [resource] } }],
  };

  if (outcome === "refunded") {
    // A refund arrives as a second event after the completed capture.
    const refundResource = {
      ...resource,
      id: `MOCK-REFUND-${String(++captureCounter).padStart(4, "0")}`,
      status: "REFUNDED",
      amount: resource.amount,
    };
    return {
      capture,
      event: baseEvent("PAYMENT.CAPTURE.COMPLETED", resource),
      followUpEvent: baseEvent("PAYMENT.CAPTURE.REFUNDED", refundResource),
    };
  }

  const eventType =
    outcome === "pending" ? "PAYMENT.CAPTURE.PENDING" : "PAYMENT.CAPTURE.COMPLETED";
  return { capture, event: baseEvent(eventType, resource) };
}

// Simulate a refund of an already-captured order.
export function mockRefundEvent(orderId) {
  const order = mockOrders.get(orderId);
  if (!order || !order.captureId) return null;
  const resource = {
    id: `MOCK-REFUND-${String(++captureCounter).padStart(4, "0")}`,
    status: "REFUNDED",
    amount: order.amount,
    create_time: new Date().toISOString(),
    update_time: new Date().toISOString(),
    supplementary_data: { related_ids: { order_id: order.id } },
  };
  return baseEvent("PAYMENT.CAPTURE.REFUNDED", resource);
}

// --- Mock webhook signing ---------------------------------------------------
// Sign a webhook payload the way the mock "PayPal" would, so the server's
// verification path can be tested. Returns the headers to attach.
export function signMockWebhook(rawBody) {
  const transmissionId = `MOCK-TXN-${Date.now().toString(36).toUpperCase()}-${Math.floor(
    Math.random() * 1e6
  )}`;
  const transmissionTime = new Date().toISOString();
  const payload = `${transmissionId}|${transmissionTime}|${rawBody}`;
  const sig = crypto
    .createHmac("sha256", mockWebhookSecret())
    .update(payload, "utf8")
    .digest("hex");
  return {
    "paypal-auth-algo": MOCK_AUTH_ALGO,
    "paypal-cert-url": "mock://paypal/mock-cert",
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-sig": sig,
    "paypal-transmission-time": transmissionTime,
  };
}

// Verify a mock-signed webhook. Returns { verified, skipped }.
export function verifyMockWebhookSignature(headers, rawBody) {
  if (headers["paypal-auth-algo"] !== MOCK_AUTH_ALGO) {
    return { verified: false, skipped: false };
  }
  const transmissionId = headers["paypal-transmission-id"];
  const transmissionTime = headers["paypal-transmission-time"];
  const transmissionSig = headers["paypal-transmission-sig"];
  if (!transmissionId || !transmissionTime || !transmissionSig) {
    return { verified: false, skipped: false };
  }
  const payload = `${transmissionId}|${transmissionTime}|${rawBody}`;
  const expected = crypto
    .createHmac("sha256", mockWebhookSecret())
    .update(payload, "utf8")
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(transmissionSig), "utf8");
  const verified = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { verified, skipped: false };
}
