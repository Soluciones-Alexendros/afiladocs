import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  checkoutRateLimit: null,
  contactRateLimit: null,
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  applyRateLimit: vi.fn().mockResolvedValue({ limited: false }),
}));

vi.mock("@/lib/stripe/client", () => {
  const catalog = new Map<
    string,
    {
      sku: string;
      stripe_price_id: string;
      eidas_level: "SES" | "AES";
      kind: string;
      delivery_mode: string;
    }
  >([
    [
      "AFD-PAK-001",
      {
        sku: "AFD-PAK-001",
        stripe_price_id: "price_test_pak",
        eidas_level: "AES",
        kind: "template",
        delivery_mode: "docuseal_fill_and_sign",
      },
    ],
    [
      "AFD-CPS-001",
      {
        sku: "AFD-CPS-001",
        stripe_price_id: "price_test_cps",
        eidas_level: "AES",
        kind: "template",
        delivery_mode: "docuseal_fill_and_sign",
      },
    ],
  ]);
  return {
    getActiveCatalog: vi.fn().mockResolvedValue(catalog),
    getProductPriceMap: vi
      .fn()
      .mockResolvedValue({
        "AFD-PAK-001": "price_test_pak",
        "AFD-CPS-001": "price_test_cps",
      }),
  };
});

vi.mock("@/lib/env", () => ({
  serverEnv: {
    stripeSecretKey: "sk_test_123",
    stripeWebhookSecret: "whsec_test",
  },
  publicEnv: { siteUrl: "http://localhost:3000" },
}));

// Mock Stripe as a class so `new Stripe(...)` works correctly
vi.mock("stripe", () => {
  class MockStripe {
    checkout = {
      sessions: {
        create: vi
          .fn()
          .mockResolvedValue({ url: "https://checkout.stripe.com/test" }),
      },
    };
  }
  return { default: MockStripe };
});

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/checkout", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Success cases first — use top-level vi.mock defaults (no doMock contamination)

  it("returns 200 with Stripe checkout URL on success", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const req = makeRequest({
      items: [{ priceId: "price_test_pak", quantity: 1 }],
      successUrl: "http://localhost/ok",
      cancelUrl: "http://localhost/cancel",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("https://checkout.stripe.com/test");
  });

  it("accepts internal product ID (AFD-*) in addition to Stripe price ID", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const req = makeRequest({
      items: [{ variantId: "AFD-PAK-001", quantity: 2 }],
      successUrl: "http://localhost/ok",
      cancelUrl: "http://localhost/cancel",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe("https://checkout.stripe.com/test");
  });

  it("returns 400 when items array is empty", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const req = makeRequest({
      items: [],
      successUrl: "http://localhost/ok",
      cancelUrl: "http://localhost/cancel",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when price ID is not in whitelist", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const req = makeRequest({
      items: [{ priceId: "price_not_whitelisted", quantity: 1 }],
      successUrl: "http://localhost/ok",
      cancelUrl: "http://localhost/cancel",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 500 when body is malformed JSON", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const req = new Request("http://localhost/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: "{invalid-json}",
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });

  it("returns 400 when successUrl is outside the site origin", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const req = makeRequest({
      items: [{ priceId: "price_test_pak", quantity: 1 }],
      successUrl: "https://evil.example.invalid/phish",
      cancelUrl: "http://localhost:3000/cancel",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  // Rate-limit test uses doMock — must come LAST to avoid contaminating earlier tests
  it("returns 429 when rate limited", async () => {
    vi.doMock("@/lib/rate-limit", () => ({
      checkoutRateLimit: {},
      contactRateLimit: null,
      getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
      applyRateLimit: vi
        .fn()
        .mockResolvedValue({ limited: true, reset: Date.now() + 60000 }),
    }));
    vi.resetModules();
    const { POST } = await import("@/app/api/checkout/route");
    const req = makeRequest({
      items: [{ price: "price_test_ltk", quantity: 1 }],
      successUrl: "http://localhost/ok",
      cancelUrl: "http://localhost/cancel",
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });
});
