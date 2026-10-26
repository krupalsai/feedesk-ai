// paypal/client.js — minimal PayPal Orders API client (sandbox-first).
//
// Credentials come ONLY from environment variables:
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV ("sandbox" | "live"),
//   PAYPAL_WEBHOOK_ID (needed for webhook signature verification).
// Nothing is hardcoded. If credentials are missing, every call throws a
// PayPalConfigError with code "PAYPAL_CREDENTIALS_MISSING" so the server can
// answer with a clear, graceful message instead of crashing.

import {
  createMockOrder,
  getMockOrder,
  verifyMockWebhookSignature,
  MOCK_AUTH_ALGO,
} from "./mock.js";

// Mode: "mock" (PAYPAL_MODE=mock) runs a local simulation with no network,
// no credentials and no real money. Anything else is "live" — the real
// PayPal sandbox/live APIs, which need credentials from the environment.
export function paypalMode() {
  return (process.env.PAYPAL_MODE || "live").toLowerCase() === "mock"
    ? "mock"
    : "live";
}

export function isMockMode() {
  return paypalMode() === "mock";
}

export class PayPalConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayPalConfigError";
    this.code = "PAYPAL_CREDENTIALS_MISSING";
  }
}

export function paypalConfig() {
  const env = (process.env.PAYPAL_ENV || "sandbox").toLowerCase();
  return {
    env,
    baseUrl:
      env === "live"
        ? "https://api-m.paypal.com"
        : "https://api-m.sandbox.paypal.com",
    clientId: process.env.PAYPAL_CLIENT_ID || "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
    webhookId: process.env.PAYPAL_WEBHOOK_ID || "",
  };
}

export function requireCredentials() {
  const cfg = paypalConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new PayPalConfigError(
      "PayPal sandbox credentials are not configured. Set PAYPAL_CLIENT_ID and " +
        "PAYPAL_CLIENT_SECRET in a .env file (see README step 3 — create a PayPal " +
        "Developer sandbox app first). No payment call was made."
    );
  }
  return cfg;
}

async function getAccessToken() {
  const cfg = requireCredentials();
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString(
    "base64"
  );
  const res = await fetch(`${cfg.baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal token request failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function paypalFetch(path, options = {}) {
  const cfg = requireCredentials();
  const token = await getAccessToken();
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      `PayPal API ${options.method || "GET"} ${path} failed (${res.status})`
    );
    err.status = res.status;
    err.paypalBody = body;
    throw err;
  }
  return body;
}

// POST /v2/checkout/orders — create a fee payment order.
// `fee` = { payerName, label, amount (string, e.g. "500.00"), currency, feeId }
// In mock mode this creates a simulated order (no network, no credentials).
export async function createOrder(fee) {
  if (isMockMode()) {
    const order = createMockOrder(fee);
    const approveLink = (order.links || []).find((l) => l.rel === "approve");
    return { orderId: order.id, status: order.status, approveUrl: approveLink?.href || null, raw: order };
  }
  const currency = (fee.currency || "USD").toUpperCase();
  const order = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: fee.feeId || undefined,
          custom_id: fee.feeId || undefined,
          description: fee.label || "Course fee",
          amount: { currency_code: currency, value: String(fee.amount) },
        },
      ],
    }),
  });
  const approveLink = (order.links || []).find((l) => l.rel === "approve");
  return { orderId: order.id, status: order.status, approveUrl: approveLink?.href || null, raw: order };
}

// POST /v2/checkout/orders/{id}/capture — capture after payer approval.
// Live mode only. In mock mode the server drives mockCapture() directly
// (paypal/mock.js) so the matching webhook event is delivered too.
export async function captureOrder(orderId) {
  if (isMockMode()) {
    throw new Error(
      "captureOrder is live-only; in mock mode the server uses mockCapture() so the webhook event is delivered with the capture."
    );
  }
  if (!orderId) throw new Error("captureOrder requires an orderId.");
  return paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: "POST",
    body: "{}",
  });
}

// GET /v2/checkout/orders/{id} — reconcile status without a webhook.
export async function getOrder(orderId) {
  if (isMockMode()) {
    const order = getMockOrder(orderId);
    if (!order) {
      const err = new Error(`Mock order ${orderId} not found.`);
      err.status = 404;
      throw err;
    }
    return order;
  }
  return paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
    method: "GET",
  });
}

// POST /v1/notifications/verify-webhook-signature — verify an incoming webhook.
// Returns { verified, skipped }. When credentials/webhook id are not configured
// yet, it returns skipped:true instead of throwing, so local development can
// still log events (the server marks them UNVERIFIED in that case).
// In mock mode, events signed with the mock HMAC scheme (paypal-auth-algo =
// MOCK-HMAC-SHA256) are verified locally; mock events without that header are
// treated as unverified, never skipped.
export async function verifyWebhookSignature(headers, rawBody) {
  if (isMockMode()) {
    if (headers["paypal-auth-algo"] === MOCK_AUTH_ALGO) {
      return verifyMockWebhookSignature(headers, rawBody);
    }
    return { verified: false, skipped: true };
  }
  const cfg = paypalConfig();
  if (!cfg.clientId || !cfg.clientSecret || !cfg.webhookId) {
    return { verified: false, skipped: true };
  }
  const token = await getAccessToken();
  const res = await fetch(`${cfg.baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: cfg.webhookId,
      webhook_event: JSON.parse(rawBody),
    }),
  });
  if (!res.ok) return { verified: false, skipped: false };
  const data = await res.json();
  return { verified: data.verification_status === "SUCCESS", skipped: false };
}
