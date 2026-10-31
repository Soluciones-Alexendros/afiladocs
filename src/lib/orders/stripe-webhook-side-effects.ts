import { revalidateTag } from "next/cache";
import React from "react";
import type Stripe from "stripe";
import { PaymentConfirmation } from "@/emails/PaymentConfirmation";
import { OrderConfirmationEmail } from "@/emails/order-confirmation";
import { IntakeRequiredEmail } from "@/emails/intake-required";
import { PaymentFailedEmail } from "@/emails/payment-failed";
import { fulfillOrderFromSession } from "@/lib/orders/fulfillment";
import { publicEnv, serverEnv } from "@/lib/env";
import { safeSendEmail } from "@/lib/email/send";
import { logEvent } from "@/lib/log/structured";
import { prisma } from "@/lib/prisma/client";

type OrderWithUser = Awaited<
  ReturnType<typeof prisma.orders.findFirst<{ include: { user: true } }>>
>;

// Estados que aún requieren fulfillment. Si el pedido ya está más allá
// (awaiting_signature, delivered, completed…), un reintento de Stripe no debe
// volver a disparar DocuSeal ni emails.
const DISPATCHABLE_STATUSES = new Set([
  "payment_completed",
  "pending_payment",
  "intake_pending",
]);

async function sendConfirmationEmail(
  session: Stripe.Checkout.Session,
  customerEmail: string,
  amount: string,
): Promise<void> {
  await safeSendEmail(
    {
      to: customerEmail,
      subject: "Confirmación de pago — afiladocs",
      react: React.createElement(PaymentConfirmation, {
        customerEmail,
        amount,
        sessionId: session.id,
      }),
    },
    "email.confirmation.failed",
    { sessionId: session.id },
  );
}

async function createAndPersistInvoice(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const { EasyVerifactuAdapter } =
    await import("@/lib/verifactu/easyverifactu");
  const adapter = new EasyVerifactuAdapter();
  const metadata = session.metadata!;

  const profile = await prisma.profiles.findFirst({
    where: { id: metadata.userId },
    select: { nif: true },
  });

  const invoiceResult = await adapter.createInvoice({
    orderId: metadata.orderId ?? session.id,
    userId: metadata.userId!,
    productId: metadata.productId ?? "unknown",
    amountCents: session.amount_total ?? 0,
    currency: session.currency ?? "eur",
    issuedAt: new Date(),
    customerNif: profile?.nif ?? "",
  });

  if (metadata.orderId) {
    await prisma.orders.update({
      where: { stripe_session_id: session.id },
      data: { invoice_id: invoiceResult.invoiceId, invoiced_at: new Date() },
    });
  }

  logEvent.info("verifactu.invoice.created", {
    invoiceId: invoiceResult.invoiceId,
    sessionId: session.id,
  });
}

async function generateVerifactuInvoice(
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (
    !serverEnv.easyVerifactuApiUrl ||
    !serverEnv.easyVerifactuApiKey ||
    !session.metadata?.userId
  ) {
    return;
  }

  try {
    await createAndPersistInvoice(session);
  } catch (verifactuErr) {
    logEvent.error("verifactu.invoice.failed", {
      message: verifactuErr instanceof Error ? verifactuErr.message : "Unknown",
      sessionId: session.id,
    });
  }
}

async function sendOrderConfirmationEmail(
  order: NonNullable<OrderWithUser>,
  customerEmail: string,
  amount: string,
): Promise<void> {
  await safeSendEmail(
    {
      to: customerEmail,
      subject: "Comprobante de tu pedido — Afiladocs",
      react: React.createElement(OrderConfirmationEmail, {
        userName: order.user.full_name ?? "Cliente",
        orderId: order.id,
        productName: order.product_id,
        amount,
        portalUrl: `${publicEnv.siteUrl}/portal/pedido/${order.id}`,
      }),
    },
    "email.order_confirmation.failed",
    { orderId: order.id },
  );
}

async function sendIntakeRequiredEmail(
  order: NonNullable<OrderWithUser>,
  customerEmail: string,
): Promise<void> {
  await safeSendEmail(
    {
      to: customerEmail,
      subject: "Acción requerida: completa los datos de tu pedido — Afiladocs",
      react: React.createElement(IntakeRequiredEmail, {
        userName: order.user.full_name ?? "Cliente",
        productName: order.product_id,
        intakeUrl: `${publicEnv.siteUrl}/portal/pedido/${order.id}`,
      }),
    },
    "email.intake_required.failed",
    { orderId: order.id },
  );
}

async function sendPaymentFailedEmail(
  customerEmail: string,
  intent: Stripe.PaymentIntent,
): Promise<void> {
  await safeSendEmail(
    {
      to: customerEmail,
      subject: "Problema con tu pago — Afiladocs",
      react: React.createElement(PaymentFailedEmail, {
        customerEmail,
        errorMessage:
          intent.last_payment_error?.message ??
          "Error desconocido en el procesamiento del pago",
        retryUrl: `${publicEnv.siteUrl}/tienda`,
      }),
    },
    "email.payment_failed.failed",
    { intentId: intent.id },
  );
}

async function processOrderPostPayment(
  order: NonNullable<OrderWithUser>,
  customerEmail: string,
  amount: string,
): Promise<void> {
  if (!DISPATCHABLE_STATUSES.has(order.status)) {
    logEvent.info("dispatch.skipped_idempotent", {
      orderId: order.id,
      status: order.status,
    });
    return;
  }
  await sendOrderConfirmationEmail(order, customerEmail, amount);
  if (order.status === "intake_pending") {
    await sendIntakeRequiredEmail(order, customerEmail);
  }
  await fulfillOrderFromSession(order, customerEmail);
}

export async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const customerEmail = session.customer_details?.email;
  const amount = new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: session.currency?.toUpperCase() ?? "EUR",
  }).format((session.amount_total ?? 0) / 100);

  logEvent.info("checkout.completed", {
    sessionId: session.id,
    amount,
  });

  if (customerEmail) {
    await sendConfirmationEmail(session, customerEmail, amount);
  }

  const order = await prisma.orders.findFirst({
    where: { stripe_session_id: session.id },
    include: { user: true },
  });

  if (order && customerEmail) {
    await processOrderPostPayment(order, customerEmail, amount);
    revalidateTag("orders", "default");
    if (order.user_id) revalidateTag(`orders-${order.user_id}`, "default");
    revalidateTag(`order-${order.id}`, "default");
  }

  await generateVerifactuInvoice(session);
}

export async function handlePaymentFailed(
  intent: Stripe.PaymentIntent,
): Promise<void> {
  const customerEmail =
    typeof intent.receipt_email === "string"
      ? intent.receipt_email
      : ((
          intent.last_payment_error?.payment_method as
            Stripe.PaymentMethod | undefined
        )?.billing_details?.email ?? null);

  logEvent.error("payment.failed", {
    intentId: intent.id,
    lastError: intent.last_payment_error?.message,
  });

  if (customerEmail) {
    await sendPaymentFailedEmail(customerEmail, intent);
  }
}
