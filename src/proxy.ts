import { NextRequest, NextResponse } from "next/server";

export default function proxy(req: NextRequest) {
  const allowedIps = (
    process.env.ALLOWED_IPS || ""
  ).split(",").map((s) => s.trim()).filter(Boolean);

  if (allowedIps.length === 0) return NextResponse.next();

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
