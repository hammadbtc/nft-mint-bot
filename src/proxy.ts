import { NextRequest, NextResponse } from "next/server";

export default function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === "/api/health") return NextResponse.next();
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
      valid = separator > -1 && decoded.slice(0, separator) === accessUser && decoded.slice(separator + 1) === accessPassword;
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
