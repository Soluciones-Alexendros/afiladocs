import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockBlockedCountries: { value: string[] } = { value: [] };
const mockPublicEnv = {
  supabaseUrl: "http://localhost",
  supabaseAnonKey: "anon",
};

vi.mock("@/lib/env", () => ({
  serverEnv: {
    get geoBlockedCountries() {
      return mockBlockedCountries.value;
    },
  },
  publicEnv: {
    get supabaseUrl() {
      return mockPublicEnv.supabaseUrl;
    },
    get supabaseAnonKey() {
      return mockPublicEnv.supabaseAnonKey;
    },
  },
  missingSupabasePublicEnvKeys() {
    const missing: string[] = [];
    if (!mockPublicEnv.supabaseUrl.trim())
      missing.push("NEXT_PUBLIC_SUPABASE_URL");
    if (!mockPublicEnv.supabaseAnonKey.trim())
      missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    return missing;
  },
  hasSupabasePublicConfig() {
    return (
      Boolean(mockPublicEnv.supabaseUrl.trim()) &&
      Boolean(mockPublicEnv.supabaseAnonKey.trim())
    );
  },
}));

vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: vi.fn(async (_req: NextRequest, headers?: Headers) => {
    const { NextResponse } = await import("next/server");
    const res = NextResponse.next({
      request: { headers: headers ?? new Headers() },
    });
    return res;
  }),
}));

function makeRequest(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(url, "http://localhost:3000"), {
    headers: new Headers(headers),
  });
}

describe("middleware", () => {
  beforeEach(() => {
    mockBlockedCountries.value = [];
    mockPublicEnv.supabaseUrl = "http://localhost";
    mockPublicEnv.supabaseAnonKey = "anon";
  });

  it("blocks suspicious paths with path traversal pattern", async () => {
    const { middleware } = await import("../../middleware");
    const res = await middleware(makeRequest("/api/%2E%2E%2Fetc%2Fpasswd"));
    expect(res.status).toBe(403);
  });

  it("blocks sqlmap UA on /api routes", async () => {
    const { middleware } = await import("../../middleware");
    const res = await middleware(
      makeRequest("/api/contact", { "user-agent": "sqlmap/1.7" }),
    );
    expect(res.status).toBe(403);
  });

  it("allows Googlebot on /api routes", async () => {
    const { middleware } = await import("../../middleware");
    const res = await middleware(
      makeRequest("/api/contact", {
        "user-agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      }),
    );
    expect(res.status).not.toBe(403);
  });

  it("skips bot detection on webhook routes", async () => {
    const { middleware } = await import("../../middleware");
    const res = await middleware(
      makeRequest("/api/webhooks/stripe", { "user-agent": "curl/8.0" }),
    );
    expect(res.status).not.toBe(403);
  });

  it("emits CSP with nonce and x-nonce header on normal requests", async () => {
    const { middleware } = await import("../../middleware");
    const res = await middleware(makeRequest("/"));
    const nonce = res.headers.get("x-nonce");
    expect(nonce).toBeTruthy();
    expect(nonce!.length).toBeGreaterThan(10);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeTruthy();
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("'unsafe-inline' https://js.stripe.com");
  });

  it("blocks geo when country is in GEO_BLOCKED_COUNTRIES", async () => {
    mockBlockedCountries.value = ["RU"];
    const { middleware } = await import("../../middleware");
    const res = await middleware(
      makeRequest("/", { "x-vercel-ip-country": "RU" }),
    );
    expect(res.status).toBe(403);
  });

  it("allows country not in block list", async () => {
    mockBlockedCountries.value = ["RU"];
    const { middleware } = await import("../../middleware");
    const res = await middleware(
      makeRequest("/", { "x-vercel-ip-country": "ES" }),
    );
    expect(res.status).not.toBe(403);
  });

  it("skips Supabase session on public pages when anon key is missing (no 500)", async () => {
    mockPublicEnv.supabaseAnonKey = "";
    const { middleware } = await import("../../middleware");
    const res = await middleware(makeRequest("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-skip")).toBe("supabase-session");
    expect(res.headers.get("x-nonce")).toBeTruthy();
  });

  it("returns controlled 503 HTML on /portal when Supabase public env is missing", async () => {
    mockPublicEnv.supabaseAnonKey = "";
    const { middleware } = await import("../../middleware");
    const res = await middleware(makeRequest("/portal/pedidos"));
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Servicio temporalmente no disponible");
    expect(body).not.toContain("eyJ");
    expect(body).not.toContain("sk_");
  });

  it("returns controlled 503 JSON on gated APIs when Supabase public env is missing", async () => {
    mockPublicEnv.supabaseUrl = "";
    const { middleware } = await import("../../middleware");
    const res = await middleware(makeRequest("/api/checkout"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("service_unavailable");
    expect(body.reason).toBe("supabase_public_env_missing");
  });

  it("does not 503 infra APIs when Supabase public env is missing", async () => {
    mockPublicEnv.supabaseAnonKey = "";
    const { middleware } = await import("../../middleware");
    const res = await middleware(makeRequest("/api/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-skip")).toBe("supabase-session");
  });
});
