// lib/store.js — FeeDesk AI fee ledger (in-memory).
//
// One fee = one row on the desk. Its settlement status is derived ONLY from
// PayPal facts — a verified capture response or a verified webhook event.
// Never from a payer's word or a screenshot.
//
// Fee statuses:
//   AWAITING_APPROVAL — order created, payer has not approved yet
//   APPROVED           — payer approved, money not captured yet
//   SETTLED            — verified PAYMENT.CAPTURE.COMPLETED (capture or webhook)
//   PENDING            — verified capture pending (review / slow method)
//   DENIED             — verified capture denied/declined
//   REFUNDED           — verified refund after a settled capture
//
// Webhook events that fail signature verification are logged and shown as
// UNVERIFIED, and they NEVER change a fee's status.

export const FEE_STATUSES = [
  "AWAITING_APPROVAL",
  "APPROVED",
  "SETTLED",
  "PENDING",
  "DENIED",
  "REFUNDED",
];

let feeCounter = 0;
const fees = new Map(); // feeId -> fee record
const webhookEvents = []; // every webhook received, verified or not

export function createFee({ payerName, label, amount, currency }) {
  const feeId = `FEE-${String(++feeCounter).padStart(4, "0")}`;
  const fee = {
    feeId,
    payerName: payerName || "Unnamed payer",
    label: label || "Course fee",
    amount: String(amount),
    currency: (currency || "USD").toUpperCase(),
    status: "AWAITING_APPROVAL",
    orderId: null,
    captureId: null,
    approveUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [], // { at, type, status, verified, headline }
    explanation: null, // latest AI explanation object
  };
  fees.set(feeId, fee);
  return fee;
}

export function getFee(feeId) {
  return fees.get(feeId) || null;
}

export function listFees() {
  return [...fees.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function findFeeByOrderId(orderId) {
  for (const fee of fees.values()) {
    if (fee.orderId === orderId) return fee;
  }
  return null;
}

export function findFeeByCaptureId(captureId) {
  for (const fee of fees.values()) {
    if (fee.captureId === captureId) return fee;
  }
  return null;
}

function touch(fee, status, eventSummary) {
  fee.status = status;
  fee.updatedAt = new Date().toISOString();
  if (eventSummary) fee.events.push(eventSummary);
}

// Attach a created PayPal order to a fee.
export function attachOrder(fee, { orderId, approveUrl, status }) {
  fee.orderId = orderId;
  fee.approveUrl = approveUrl || null;
  if (status === "APPROVED") touch(fee, "APPROVED");
  return fee;
}

// Apply a capture response (direct API answer) to a fee. Only a COMPLETED
// capture settles the fee; PENDING / DECLINED map to their statuses.
export function applyCaptureResponse(fee, capture) {
  const cap = capture?.purchase_units?.[0]?.payments?.captures?.[0] || capture;
  const status = cap?.status;
  if (!status) return fee;
  if (status === "COMPLETED") {
    fee.captureId = cap.id || fee.captureId;
    touch(fee, "SETTLED", {
      at: new Date().toISOString(),
      type: "CAPTURE_RESPONSE",
      status,
      verified: true,
      headline: "Capture response: COMPLETED",
    });
  } else if (status === "PENDING") {
    fee.captureId = cap.id || fee.captureId;
    touch(fee, "PENDING", {
      at: new Date().toISOString(),
      type: "CAPTURE_RESPONSE",
      status,
      verified: true,
      headline: "Capture response: PENDING",
    });
  } else if (status === "DECLINED" || status === "DENIED") {
    touch(fee, "DENIED", {
      at: new Date().toISOString(),
      type: "CAPTURE_RESPONSE",
      status,
      verified: true,
      headline: "Capture response: DECLINED",
    });
  }
  return fee;
}

// Apply a webhook event to the ledger. Returns { fee, applied }.
// Unverified events are recorded but never change status.
export function applyWebhookEvent(event, verification) {
  const record = {
    receivedAt: new Date().toISOString(),
    verified: verification.verified,
    verificationSkipped: verification.skipped,
    eventType: event.event_type || null,
    eventId: event.id || null,
    resourceId: event.resource?.id || null,
    resourceStatus: event.resource?.status || null,
  };
  webhookEvents.push({ ...record, event });

  if (!verification.verified) {
    return { fee: null, applied: false, record };
  }

  const resource = event.resource || {};
  const orderId = resource?.supplementary_data?.related_ids?.order_id || null;
  const fee =
    (orderId && findFeeByOrderId(orderId)) ||
    (resource.id && findFeeByCaptureId(resource.id)) ||
    null;
  if (!fee) return { fee: null, applied: false, record };

  const summary = {
    at: record.receivedAt,
    type: event.event_type,
    status: resource.status || null,
    verified: true,
    headline: `Webhook: ${event.event_type}`,
  };

  switch (event.event_type) {
    case "CHECKOUT.ORDER.APPROVED":
      if (fee.status === "AWAITING_APPROVAL") touch(fee, "APPROVED", summary);
      break;
    case "PAYMENT.CAPTURE.COMPLETED":
      fee.captureId = resource.id || fee.captureId;
      touch(fee, "SETTLED", summary);
      break;
    case "PAYMENT.CAPTURE.PENDING":
      fee.captureId = resource.id || fee.captureId;
      touch(fee, "PENDING", summary);
      break;
    case "PAYMENT.CAPTURE.DENIED":
      touch(fee, "DENIED", summary);
      break;
    case "PAYMENT.CAPTURE.REFUNDED":
      touch(fee, "REFUNDED", summary);
      break;
    default:
      fee.events.push(summary);
      break;
  }
  return { fee, applied: true, record };
}

export function setExplanation(fee, explanation) {
  fee.explanation = explanation;
  fee.updatedAt = new Date().toISOString();
  return fee;
}

export function listWebhookEvents() {
  return webhookEvents;
}

export function resetStore() {
  fees.clear();
  webhookEvents.length = 0;
  feeCounter = 0;
}
