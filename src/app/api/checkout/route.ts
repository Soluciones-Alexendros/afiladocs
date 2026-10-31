import { NextResponse } from "next/server";
import { z } from "zod";
import { publicEnv, serverEnv } from "@/lib/env";
import {
  checkoutRateLimit,
  getClientIp,
  applyRateLimit,
} from "@/lib/rate-limit";
import { getActiveCatalog, type CatalogEntry } from "@/lib/stripe/client";
import { isAllowedOrigin } from "@/lib/csrf";

// Vercel Function: Node.js runtime requerido por Stripe SDK (crypto nativo de Node)
export const runtime = "nodejs";
export const maxDuration = 30;

const LineItemSchema = z.object({
  priceId: z.string().optional(),
  variantId: z.string().optional(),
  quantity: z.number().int().min(1).max(10),
});

/** Solo orígenes del sitio (evita open-redirect en success/cancel de Stripe). */
function isSiteOwnedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const site = new URL(publicEnv.siteUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const allowedHostnames = new Set([
      site.hostname,
      "afiladocs.com",
      "www.afiladocs.com",
      "afiladocs.vercel.app",
    ]);
    if (!allowedHostnames.has(url.hostname)) return false;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return true;
    }
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

const SiteUrlSchema = z
  .string()
  .url()
  .refine(isSiteOwnedUrl, { message: "URL fuera del origen del sitio" });

const CheckoutBodySchema = z.object({
  items: z.array(LineItemSchema).min(1).max(20),
  successUrl: SiteUrlSchema,
  cancelUrl: SiteUrlSchema,
});

type LineItem = z.infer<typeof LineItemSchema>;

type ResolvedItem = { entry: CatalogEntry; quantity: number };

function resolveItems(
  items: LineItem[],
  catalog: Map<string, CatalogEntry>,
): ResolvedItem[] | { error: string } {
  const bySku = catalog;
  const byStripePriceId = new Map<string, CatalogEntry>();
  for (const e of catalog.values()) byStripePriceId.set(e.stripe_price_id, e);

  const resolved: ResolvedItem[] = [];
  for (const item of items) {
    const key = item.variantId ?? item.priceId;
    if (!key) return { error: "Cada item debe incluir variantId o priceId" };
    const entry = bySku.get(key) ?? byStripePriceId.get(key);
    if (!entry) return { error: `Producto no reconocido: ${key}` };
    resolved.push({ entry, quantity: item.quantity });
  }
  return resolved;
}

async function buildStripeSession(
  resolved: ResolvedItem[],
  successUrl: string,
  cancelUrl: string,
) {
  if (!serverEnv.stripeSecretKey) return null;

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(serverEnv.stripeSecretKey, {
    apiVersion: "2026-06-24.dahlia",
    timeout: 8000,
  });

  return stripe.checkout.sessions.create({
    mode: "payment",
    line_items: resolved.map((r) => ({
      price: r.entry.stripe_price_id,
      quantity: r.quantity,
    })),
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      skus: resolved.map((r) => r.entry.sku).join(","),
    },
  });
}

async function processCheckout(request: Request): Promise<NextResponse> {
  const body = await request.json();
  const parsed = CheckoutBodySchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Parámetros inválidos",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const { items, successUrl, cancelUrl } = parsed.data;

  const catalog = await getActiveCatalog();
  if (catalog.size === 0) {
    return NextResponse.json(
      {
        error:
          "Catálogo vacío. Publica al menos un producto activo con stripe_price_id.",
      },
      { status: 503 },
    );
  }

  const resolution = resolveItems(items, catalog);
  if ("error" in resolution) {
    return NextResponse.json({ error: resolution.error }, { status: 400 });
  }

  const session = await buildStripeSession(resolution, successUrl, cancelUrl);

  if (!session) {
    return NextResponse.json(
      {
        error:
          "Stripe no está configurado. Añade STRIPE_SECRET_KEY al entorno.",
        url: null,
      },
      { status: 503 },
    );
  }

  return NextResponse.json({ url: session.url });
}

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ip = getClientIp(request);
  const { limited, retryAfter } = await applyRateLimit(checkoutRateLimit, ip);
  if (limited) {
    return NextResponse.json(
      { error: "Demasiadas solicitudes de pago. Espera unos minutos." },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter ?? 60) },
      },
    );
  }

  try {
    return await processCheckout(request);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "checkout.error",
        message: error instanceof Error ? error.message : "Unknown error",
        ts: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      { error: "Error al procesar el pago. Inténtalo de nuevo." },
      { status: 500 },
    );
  }
}
