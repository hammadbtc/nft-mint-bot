import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

const failedAuth = new Map<string, { windowStartedAt: number; count: number }>();
const publicProbes = new Map<string, { windowStartedAt: number; count: number }>();
const authenticatedMutations = new Map<string, { windowStartedAt: number; count: number }>();
const AUTH_WINDOW_MS = 60_000;
const MAX_FAILED_AUTH = 10;
const MAX_PUBLIC_PROBES = 120;
const MAX_AUTHENTICATED_MUTATIONS = 120;
const MAX_MUTATION_BYTES = 1_000_000;
const MAX_AUTH_BUCKETS = 10_000;

function clientAddress(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").map((item) => item.trim()).filter(Boolean);
  return req.headers.get("x-real-ip")
    || forwarded?.at(-1)
    || "127.0.0.1";
}

function authFailureLimited(address: string, now = Date.now()): boolean {
  if (failedAuth.size >= MAX_AUTH_BUCKETS && !failedAuth.has(address)) {
    for (const [key, value] of failedAuth) {
      if (now - value.windowStartedAt >= AUTH_WINDOW_MS) failedAuth.delete(key);
    }
    if (failedAuth.size >= MAX_AUTH_BUCKETS) failedAuth.delete(failedAuth.keys().next().value as string);
  }
  const current = failedAuth.get(address);
  const bucket = !current || now - current.windowStartedAt >= AUTH_WINDOW_MS
    ? { windowStartedAt: now, count: 0 }
    : current;
  bucket.count += 1;
  failedAuth.set(address, bucket);
  return bucket.count > MAX_FAILED_AUTH;
}

function requestLimited(
  buckets: Map<string, { windowStartedAt: number; count: number }>,
  address: string,
  limit: number,
  now = Date.now(),
): boolean {
  if (buckets.size >= MAX_AUTH_BUCKETS && !buckets.has(address)) {
    for (const [key, value] of buckets) if (now - value.windowStartedAt >= AUTH_WINDOW_MS) buckets.delete(key);
    if (buckets.size >= MAX_AUTH_BUCKETS) buckets.delete(buckets.keys().next().value as string);
  }
  const current = buckets.get(address);
  const bucket = !current || now - current.windowStartedAt >= AUTH_WINDOW_MS
    ? { windowStartedAt: now, count: 0 }
    : current;
  bucket.count += 1;
  buckets.set(address, bucket);
  return bucket.count > limit;
}

function sameSecret(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function contentSecurityPolicy(nonce: string): string {
  const development = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  return `default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: https:; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development}; style-src 'self' 'nonce-${nonce}'; style-src-elem 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; upgrade-insecure-requests`;
}

function continueRequest(req: NextRequest, nonce: string, policy: string): NextResponse {
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

function securedResponse(response: NextResponse, policy: string): NextResponse {
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function continueAuthorizedRequest(req: NextRequest, nonce: string, policy: string): NextResponse {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)
    && requestLimited(authenticatedMutations, clientAddress(req), MAX_AUTHENTICATED_MUTATIONS)) {
    return securedResponse(new NextResponse("Too many mutation requests", { status: 429, headers: { "Retry-After": "60" } }), policy);
  }
  return continueRequest(req, nonce, policy);
}

function rejectCrossSiteMutation(req: NextRequest): NextResponse | null {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Cross-site request rejected" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (!origin) return null; // Allows authenticated non-browser operator clients.
  try {
    const originUrl = new URL(origin);
    const requestHost = req.headers.get("x-forwarded-host") || req.headers.get("host");
    if (!requestHost || originUrl.host !== requestHost) {
      return NextResponse.json({ error: "Request origin rejected" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Request origin rejected" }, { status: 403 });
  }
  return null;
}

export default function proxy(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const policy = contentSecurityPolicy(nonce);
  if (["/api/health", "/api/live"].includes(req.nextUrl.pathname)) {
    if (requestLimited(publicProbes, clientAddress(req), MAX_PUBLIC_PROBES)) {
      return securedResponse(new NextResponse("Too many probe requests", { status: 429, headers: { "Retry-After": "60" } }), policy);
    }
    return continueRequest(req, nonce, policy);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const declaredLength = req.headers.get("content-length");
    if ((!declaredLength && req.body) || req.headers.has("transfer-encoding")) {
      return securedResponse(NextResponse.json({ error: "A bounded Content-Length header is required" }, { status: 411 }), policy);
    }
    const length = Number(declaredLength || 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MUTATION_BYTES) {
      return securedResponse(NextResponse.json({ error: "Request body is too large" }, { status: 413 }), policy);
    }
  }
  const crossSite = rejectCrossSiteMutation(req);
  if (crossSite) return securedResponse(crossSite, policy);
  const allowedIps = (
    process.env.ALLOWED_IPS || ""
  ).split(",").map((s) => s.trim()).filter(Boolean);

  const accessUser = process.env.APP_ACCESS_USER || "mintbot";
  const accessPassword = process.env.APP_ACCESS_PASSWORD || "";
  if (accessPassword) {
    const authorization = req.headers.get("authorization") || "";
    if (authorization.length > 2_048) {
      return securedResponse(new NextResponse("Authentication header is too large", { status: 431 }), policy);
    }
    const encoded = authorization.startsWith("Basic ") ? authorization.slice(6) : "";
    let valid = false;
    try {
      const decoded = atob(encoded);
      const separator = decoded.indexOf(":");
      valid = separator > -1 && sameSecret(decoded.slice(0, separator), accessUser) && sameSecret(decoded.slice(separator + 1), accessPassword);
    } catch { valid = false; }
    if (!valid) {
      if (authFailureLimited(clientAddress(req))) {
        return securedResponse(new NextResponse("Too many authentication failures", { status:429, headers:{ "Retry-After": "60" } }), policy);
      }
      return securedResponse(new NextResponse("Authentication required", { status:401, headers:{"WWW-Authenticate":'Basic realm="MintBot", charset="UTF-8"'} }), policy);
    }
    failedAuth.delete(clientAddress(req));
    return continueAuthorizedRequest(req, nonce, policy);
  }

  if (allowedIps.length === 0) {
    if (process.env.NODE_ENV === "production") return securedResponse(NextResponse.json({ error:"MintBot access control is not configured" }, { status:503 }), policy);
    return continueAuthorizedRequest(req, nonce, policy);
  }

  const clientIp = clientAddress(req);

  if (clientIp === "::1" || clientIp === "127.0.0.1" || clientIp === "localhost") {
    return continueAuthorizedRequest(req, nonce, policy);
  }

  if (!allowedIps.includes(clientIp)) {
    return securedResponse(NextResponse.json({ error: "Access denied" }, { status: 403 }), policy);
  }

  return continueAuthorizedRequest(req, nonce, policy);
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
