// ai/explain.js — FeeDesk AI payment explainer.
//
// Interface: explainPaymentEvent(event) -> { headline, explanation, next_step,
// confidence_note, source } where `event` is a PayPal webhook payload or a
// capture-order response. `source` is "llm" when a configured model answered
// (GROQ_API_KEY or GEMINI_API_KEY set), otherwise "rules-fallback" — a
// deterministic rule-based explainer that answers from the event type/status
// and always works offline with no key. The LLM is an optional enhancement
// only; any LLM failure falls back to the rules silently.

export const EXPLANATION_PROMPT = `You are the assistant inside FeeDesk AI, a fee-collection desk
used by non-technical staff at a small coaching institute.

You will receive one PayPal payment event as JSON (a webhook payload or a
capture response). Explain it to a staff member who does not know payment
jargon.

Rules:
- Say plainly whether the fee is SETTLED, PENDING, or NOT PAID.
- Give the most likely reason for the status, using only facts present in the
  JSON (status, event_type, reason/status_detail, processor fields). Never
  invent a reason that is not supported by the payload; if the payload does
  not say why, say so.
- Give exactly one clear next step for staff (or "No action needed").
- Never tell staff to mark a fee as paid unless the event shows a completed
  capture (PAYMENT.CAPTURE.COMPLETED or capture status COMPLETED).
- Keep it under 60 words total. No JSON jargon in the explanation itself.

Return ONLY a JSON object:
{ "headline": string, "explanation": string, "next_step": string,
  "confidence_note": string }`;

// --- LLM call ---------------------------------------------------------------
// Optional enhancement, inert without a key. If GROQ_API_KEY is set, the
// prompt goes to Groq (free tier, OpenAI-compatible chat completions). Else
// if GEMINI_API_KEY is set, it goes to Gemini's REST API. Either way the
// model must return the JSON object from EXPLANATION_PROMPT; anything else
// (timeout, bad key, bad JSON) returns null and the caller uses the
// deterministic rule-based fallback. No key is ever required: the rules
// fallback is the default and always works offline.
const LLM_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseLlmJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj.headline === "string" && typeof obj.explanation === "string") {
      return {
        headline: obj.headline,
        explanation: obj.explanation,
        next_step: typeof obj.next_step === "string" ? obj.next_step : "No action needed.",
        confidence_note:
          typeof obj.confidence_note === "string"
            ? obj.confidence_note
            : "Based on the PayPal event payload.",
      };
    }
  } catch {}
  return null;
}

async function callGroq(prompt) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return parseLlmJson(data?.choices?.[0]?.message?.content || "");
}

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 },
      }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return parseLlmJson(text);
}

async function callLLM(prompt) {
  try {
    return (await callGroq(prompt)) || (await callGemini(prompt));
  } catch {
    return null;
  }
}

// Which LLM, if any, is configured (for status reporting only — never a key).
export function llmStatus() {
  if (process.env.GROQ_API_KEY) return { provider: "groq", configured: true };
  if (process.env.GEMINI_API_KEY) return { provider: "gemini", configured: true };
  return { provider: null, configured: false };
}

function buildPrompt(event) {
  return `${EXPLANATION_PROMPT}\n\nPayPal event JSON:\n${JSON.stringify(event, null, 2)}`;
}

function summariseEvent(event) {
  const type = event?.event_type || event?.eventType || null;
  const resource = event?.resource || event || {};
  const status =
    resource?.status ||
    resource?.supplementary_data?.related_ids?.order_id_status ||
    null;
  const amount =
    resource?.amount?.value && resource?.amount?.currency_code
      ? `${resource.amount.currency_code} ${resource.amount.value}`
      : null;
  const reason =
    resource?.status_details?.reason || resource?.status_detail?.reason || null;
  return { type, status, amount, reason };
}

// Deterministic fallback — used until callLLM is wired, and kept as a safety
// net afterwards. Covers the statuses the desk actually acts on.
function ruleBasedExplanation(event) {
  const { type, status, amount, reason } = summariseEvent(event);
  const amt = amount ? ` (${amount})` : "";

  if (type === "PAYMENT.CAPTURE.COMPLETED" || status === "COMPLETED") {
    return {
      headline: "Fee settled — payment received",
      explanation: `PayPal confirms the payment${amt} was captured successfully. The money is in the institute's PayPal account.`,
      next_step: "No action needed. You may mark this fee as paid.",
      confidence_note: "Based on a completed capture event from PayPal.",
    };
  }
  if (type === "PAYMENT.CAPTURE.PENDING" || status === "PENDING") {
    return {
      headline: "Payment pending — not settled yet",
      explanation: `The payment${amt} was started but PayPal has not finished processing it${reason ? ` (reason: ${reason})` : ""}. This can happen during a payment review or with slower payment methods.`,
      next_step: "Wait and re-check later. Do NOT mark the fee as paid until a completed event arrives.",
      confidence_note: "Based on a pending capture event from PayPal.",
    };
  }
  if (
    type === "PAYMENT.CAPTURE.DENIED" ||
    status === "DECLINED" ||
    status === "DENIED"
  ) {
    return {
      headline: "Payment failed — fee NOT paid",
      explanation: `PayPal could not complete this payment${amt}${reason ? ` (reason: ${reason})` : ""}. A common cause is the payer's bank or card refusing the payment.`,
      next_step: "Ask the payer to retry with a different payment method. Do not mark the fee as paid.",
      confidence_note: "Based on a denied/declined capture event from PayPal.",
    };
  }
  if (type === "PAYMENT.CAPTURE.REFUNDED" || status === "REFUNDED") {
    return {
      headline: "Payment refunded — fee reopened",
      explanation: `This payment${amt} was refunded to the payer, so the fee is no longer settled.`,
      next_step: "Treat the fee as unpaid again and contact the payer.",
      confidence_note: "Based on a refund event from PayPal.",
    };
  }
  if (type === "CHECKOUT.ORDER.APPROVED") {
    return {
      headline: "Payer approved — capture to finish",
      explanation: `The payer approved the payment${amt} but the money has not been captured yet.`,
      next_step: "Capture the order from the desk to complete the payment.",
      confidence_note: "Based on an order-approved event from PayPal.",
    };
  }
  return {
    headline: "Status unclear — check before acting",
    explanation: `This PayPal event (${type || status || "unknown"}) does not by itself prove the fee was paid.`,
    next_step: "Check the order status in PayPal before marking anything as paid.",
    confidence_note: "The event type was not one the explainer recognises.",
  };
}

export async function explainPaymentEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("explainPaymentEvent requires a PayPal event object.");
  }
  const llmResult = await callLLM(buildPrompt(event));
  if (llmResult) return { ...llmResult, source: "llm" };
  return { ...ruleBasedExplanation(event), source: "rules-fallback" };
}
