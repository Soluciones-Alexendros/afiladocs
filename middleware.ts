import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { missingSupabasePublicEnvKeys, serverEnv } from "@/lib/env";

const AUTH_GATED_PREFIXES = [
  "/portal",
  "/ops",
  "/login",
  "/registro",
  "/recuperar-password",
] as const;

function isAuthGatedPath(pathname: string): boolean {
  return AUTH_GATED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isInfraApiPath(pathname: string): boolean {
  return (
    pathname === "/api/health" ||
    pathname.startsWith("/api/health/") ||
    pathname.startsWith("/api/webhooks/") ||
    pathname.startsWith("/api/cron/")
  );
}

function applySecurityHeaders(
  response: NextResponse,
  nonce: string,
  csp: string,
): NextResponse {
  response.headers.set("x-nonce", nonce);
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

function responseForMissingSupabaseEnv(
  pathname: string,
  requestHeaders: Headers,
  nonce: string,
  csp: string,
): NextResponse {
  if (isAuthGatedPath(pathname)) {
    return supabaseUnavailablePage(nonce, csp);
  }

  if (pathname.startsWith("/api/") && !isInfraApiPath(pathname)) {
    return NextResponse.json(
      { error: "service_unavailable", reason: "supabase_public_env_missing" },
      {
        status: 503,
        headers: {
          "retry-after": "120",
          "cache-control": "no-store",
          "x-nonce": nonce,
          "Content-Security-Policy": csp,
        },
      },
    );
  }

  const skipped = NextResponse.next({ request: { headers: requestHeaders } });
  skipped.headers.set("x-middleware-skip", "supabase-session");
  return applySecurityHeaders(skipped, nonce, csp);
}

function supabaseUnavailablePage(nonce: string, csp: string): NextResponse {
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Servicio no disponible — Afiladocs</title>
  <style>
    body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0}
    main{max-width:36rem;padding:2rem}
    h1{font-size:1.5rem;margin:0 0 1rem}
    p{line-height:1.55;color:#cbd5e1}
  </style>
</head>
<body>
  <main>
    <h1>Servicio temporalmente no disponible</h1>
    <p>No se puede iniciar la sesión porque falta configuración de autenticación en este deployment. Las páginas públicas pueden seguir accesibles. Operaciones debe completar las variables de entorno en Vercel y redesplegar.</p>
  </main>
</body>
</html>`;

  return new NextResponse(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "120",
      "content-security-policy": csp,
      "x-nonce": nonce,
    },
  });
}

const SUSPICIOUS_PATH_RE = /(\.\.|\/etc\/|\/proc\/|<script|%3Cscript)/i;
const BOT_UA_RE =
  /bot|crawl|spider|scan|masscan|zgrab|nuclei|sqlmap|nikto|curl|wget/i;
// Legitimate crawlers — allow through bot filter. Reverse-DNS isn't available
// on Edge, so UA allowlist is the practical ceiling here.
const LEGIT_BOT_UA_RE =
  /googlebot|bingbot|duckduckbot|applebot|yandexbot|baiduspider|slurp|facebookexternalhit|twitterbot|linkedinbot/i;

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com https://browser.sentry-cdn.com`,
    // Tailwind v4 requires unsafe-inline styles — tracked in guia-seguridad.md
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https: https://*.supabase.co",
    "connect-src 'self' https://api.stripe.com https://*.supabase.co https://vitals.vercel-insights.com https://*.sentry.io https://o*.ingest.de.sentry.io",
    "frame-src https://js.stripe.com https://hooks.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. Suspicious path detection — block globally (decode to catch encoded traversals)
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }
  if (SUSPICIOUS_PATH_RE.test(decodedPathname)) {
    console.warn(
      JSON.stringify({
        event: "security.suspicious_path",
        path: pathname,
        ip: request.headers.get("x-forwarded-for") ?? "unknown",
        ts: new Date().toISOString(),
      }),
    );
    return new NextResponse("Forbidden", { status: 403 });
  }

  // 2. Bot detection — block on API routes (webhooks excluded: they use HMAC auth)
  if (pathname.startsWith("/api/") && !pathname.startsWith("/api/webhooks/")) {
    const userAgent = request.headers.get("user-agent") ?? "";
    if (BOT_UA_RE.test(userAgent) && !LEGIT_BOT_UA_RE.test(userAgent)) {
      console.warn(
        JSON.stringify({
          event: "security.bot_blocked",
          user_agent: userAgent.slice(0, 100),
          path: pathname,
          ts: new Date().toISOString(),
        }),
      );
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // 3. Geo-blocking via Vercel Edge header (GEO_BLOCKED_COUNTRIES env, empty by default — RGPD)
  const blockedCountries = serverEnv.geoBlockedCountries;
  if (blockedCountries.length > 0) {
    const country = request.headers.get("x-vercel-ip-country");
    if (country && blockedCountries.includes(country)) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // 4. CSP nonce per request — propagated to RSC via x-nonce and enforced via response CSP.
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next.js reads CSP from the request header to auto-add nonce to its own <script> tags.
  requestHeaders.set("content-security-policy", csp);

  // 5. Supabase auth session refresh — never throw if public env is missing
  // (prod 500: "URL and Key are required to create a Supabase client!").
  const missingSupabase = missingSupabasePublicEnvKeys();
  if (missingSupabase.length > 0) {
    console.error(
      JSON.stringify({
        event: "middleware.supabase_env_missing",
        missing: missingSupabase,
        path: pathname,
        ts: new Date().toISOString(),
      }),
    );
    return responseForMissingSupabaseEnv(pathname, requestHeaders, nonce, csp);
  }

  const response = await updateSession(request, requestHeaders);
  return applySecurityHeaders(response, nonce, csp);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - Static assets with common extensions
     *
     * Note: we DO run on /api/* so bot detection and CSP apply there too.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
