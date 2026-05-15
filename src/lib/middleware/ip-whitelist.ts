import { NextRequest, NextResponse } from "next/server";

/**
 * IP whitelist middleware.
 * Set ALLOWED_IPS in app config (comma-separated) or env var.
 * If not configured, all IPs are allowed.
 */
export async function ipWhitelistMiddleware(req: NextRequest) {
  // Skip for API routes that don't need protection? No — protect everything.
  const allowedIps = (
    process.env.ALLOWED_IPS ||
    process.env.NEXT_PUBLIC_ALLOWED_IPS ||
    ""
  ).split(",").map((s) => s.trim()).filter(Boolean);

  if (allowedIps.length === 0) return; // not configured, allow all

  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  if (!allowedIps.includes(clientIp) && clientIp !== "::1" && clientIp !== "127.0.0.1") {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
}
