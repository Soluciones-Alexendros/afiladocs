import { NextResponse } from "next/server";
import Stripe from "stripe";
import { serverEnv } from "@/lib/env";
import { logEvent } from "@/lib/log/structured";
import { prisma } from "@/lib/prisma/client";
import { notifyOpsError } from "@/lib/alerts/notify-ops";
import {
  handleCheckoutCompleted,
  handlePaymentFailed,
} from "@/lib/orders/stripe-webhook-side-effects";

// Vercel Function: Node.js runtime requerido para crypto nativo (verificación HMAC-SHA256 Stripe)
export const runtime = "nodejs";
// force-dynamic: Stripe necesita el raw body sin cachear para verificar la firma
export const dynamic = "force-dynamic";

// Lazy getter — Stripe lanza si la key está vacía en carga del módulo (build time).
function getStripe() {
  const key = serverEnv.stripeSecretKey;
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2026-06-24.dahlia" });
}

/** Returns true if this Stripe event ID was already processed (idempotency guard). */
async function isAlreadyProcessed(eventId: string): Promise<boolean> {
  const existing = await prisma.audit_log
    .findFirst({
      where: { event: `stripe_event.${eventId}` },
    })
    .catch(() => null);
  return existing !== null;
}

async function recordProcessedEvent(event: Stripe.Event): Promise<void> {
  await prisma.audit_log
    .create({
      data: {
        event: `stripe_event.${event.id}`,
        metadata: { type: event.type },
      },
    })
    .catch((err: unknown) => {
      logEvent.error("stripe.webhook.idempotency_log_failed", {
        stripeEventId: event.id,
        message: err instanceof Error ? err.message : "Unknown",
      });
    });
}

async function routeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(
        event.data.object as Stripe.Checkout.Session,
      );
      return;
    case "payment_intent.payment_failed":
      await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
      return;
    default:
      logEvent.info("stripe.unhandled", { type: event.type });
  }
}

async function dispatchEvent(event: Stripe.Event): Promise<void> {
  try {
    await routeEvent(event);
    await recordProcessedEvent(event);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    logEvent.error("stripe.handler.error", {
      type: event.type,
      message: errMsg,
    });
    void notifyOpsError({
      event: "stripe.handler.error",
      message: errMsg,
      severity: "critical",
      metadata: { type: event.type },
    });
  }
}

export async function POST(req: Request) {
  const stripe = getStripe();
  if (!stripe || !serverEnv.stripeWebhookSecret) {
    logEvent.error("stripe.webhook.misconfigured", {
      message: "Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET",
    });
    return new NextResponse("Webhook not configured", { status: 503 });
  }

  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return new NextResponse("Missing stripe-signature header", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      serverEnv.stripeWebhookSecret,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logEvent.error("stripe.webhook.signature_failed", { message });
    void notifyOpsError({
      event: "stripe.webhook.signature_failed",
      message,
      severity: "critical",
    });
    return new NextResponse(`Webhook signature invalid: ${message}`, {
      status: 400,
    });
  }

  if (await isAlreadyProcessed(event.id)) {
    console.log(
      JSON.stringify({
        event: "stripe.webhook.duplicate",
        stripeEventId: event.id,
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json({ received: true });
  }

  await dispatchEvent(event);

  return NextResponse.json({ received: true });
}
