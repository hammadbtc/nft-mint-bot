import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
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
  if (req.nextUrl.pathname === "/api/health") return NextResponse.next();
  const crossSite = rejectCrossSiteMutation(req);
  if (crossSite) return crossSite;
  const allowedIps = (
    process.env.ALLOWED_IPS || ""
  ).split(",").map((s) => s.trim()).filter(Boolean);

  const accessUser = process.env.APP_ACCESS_USER || "mintbot";
  const accessPassword = process.env.APP_ACCESS_PASSWORD || "";
  if (accessPassword) {
    const authorization = req.headers.get("authorization") || "";
    const encoded = authorization.startsWith("Basic ") ? authorization.slice(6) : "";
    let valid = false;
    try {
      const decoded = atob(encoded);
      const separator = decoded.indexOf(":");
      valid = separator > -1 && sameSecret(decoded.slice(0, separator), accessUser) && sameSecret(decoded.slice(separator + 1), accessPassword);
    } catch { valid = false; }
    if (!valid) return new NextResponse("Authentication required", { status:401, headers:{"WWW-Authenticate":'Basic realm="MintBot", charset="UTF-8"'} });
    return NextResponse.next();
  }

  if (allowedIps.length === 0) {
    if (process.env.NODE_ENV === "production") return NextResponse.json({ error:"MintBot access control is not configured" }, { status:503 });
    return NextResponse.next();
  }

  const clientIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1";

  if (clientIp === "::1" || clientIp === "127.0.0.1" || clientIp === "localhost") {
    return NextResponse.next();
  }

  if (!allowedIps.includes(clientIp)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
