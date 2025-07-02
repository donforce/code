// Stripe Webhook Handler for Backend
// This forwards Stripe webhooks to the frontend Next.js application

import Stripe from "stripe";
import crypto from "crypto";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-04-30.basil",
});

// Frontend URL where Stripe webhooks should be sent
const FRONTEND_WEBHOOK_URL =
  process.env.FRONTEND_WEBHOOK_URL ||
  "https://clear-git-test.vercel.app/api/stripe-webhook";

export async function handleStripeWebhook(request, reply) {
  try {
    console.log(
      "🔄 [Backend] Stripe webhook received, forwarding to frontend..."
    );

    const rawBody = request.rawBody;
    const signature = request.headers["stripe-signature"];

    if (!signature) {
      console.error("❌ [Backend] No Stripe signature found");
      return reply.code(400).send({ error: "No signature" });
    }

    // Verify the webhook signature
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      console.log("✅ [Backend] Webhook signature verified");
    } catch (err) {
      console.error(
        "❌ [Backend] Webhook signature verification failed:",
        err.message
      );
      return reply.code(400).send({ error: "Invalid signature" });
    }

    // Forward the webhook to the frontend
    console.log(
      "📤 [Backend] Forwarding webhook to frontend:",
      FRONTEND_WEBHOOK_URL
    );

    const response = await fetch(FRONTEND_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signature,
        "User-Agent": "Clear-Backend-Webhook-Forwarder/1.0",
      },
      body: rawBody,
    });

    if (response.ok) {
      console.log("✅ [Backend] Webhook forwarded successfully to frontend");
      return reply.send({ success: true, message: "Webhook forwarded" });
    } else {
      const errorText = await response.text();
      console.error(
        "❌ [Backend] Error forwarding webhook:",
        response.status,
        errorText
      );
      return reply.code(response.status).send({
        error: "Frontend webhook failed",
        details: errorText,
      });
    }
  } catch (error) {
    console.error("❌ [Backend] Error handling Stripe webhook:", error);
    return reply.code(500).send({ error: "Internal server error" });
  }
}

// Test function to verify webhook forwarding
export async function testWebhookForwarding() {
  try {
    console.log("🧪 [Backend] Testing webhook forwarding...");

    const testEvent = {
      id: "evt_test_" + Date.now(),
      object: "event",
      api_version: "2025-04-30.basil",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "cs_test_" + Date.now(),
          object: "checkout.session",
          amount_total: 19700,
          currency: "usd",
          customer: "cus_test_customer",
          customer_email: "test@example.com",
          mode: "subscription",
          payment_status: "paid",
          subscription: "sub_test_subscription_" + Date.now(),
          metadata: {
            userId: "test-user-id",
          },
        },
      },
      livemode: false,
      pending_webhooks: 1,
      request: {
        id: "req_test_" + Date.now(),
        idempotency_key: null,
      },
      type: "checkout.session.completed",
    };

    const payload = JSON.stringify(testEvent);
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${payload}`;
    const signature = crypto
      .createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET)
      .update(signedPayload, "utf8")
      .digest("hex");

    const stripeSignature = `t=${timestamp},v1=${signature}`;

    const response = await fetch(FRONTEND_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": stripeSignature,
        "User-Agent": "Clear-Backend-Test/1.0",
      },
      body: payload,
    });

    console.log(
      "📥 [Backend] Test response:",
      response.status,
      response.statusText
    );

    if (response.ok) {
      console.log("✅ [Backend] Webhook forwarding test successful");
    } else {
      const errorText = await response.text();
      console.log("❌ [Backend] Webhook forwarding test failed:", errorText);
    }
  } catch (error) {
    console.error("❌ [Backend] Error testing webhook forwarding:", error);
  }
}
