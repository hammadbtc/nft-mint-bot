import type { NextRequest } from "next/server";
import { safeSecretEqual } from "@/lib/safety";

export function requireAdminPassword(request: NextRequest): void {
  const supplied = request.headers.get("x-admin-password") || "";
  if (!adminPasswordAccepted(supplied)) throw new Error("Admin password is incorrect");
}

export function adminPasswordAccepted(supplied: string): boolean {
  const expected = process.env.ADMIN_ACTION_PASSWORD?.trim()
    || process.env.APP_ACCESS_PASSWORD?.trim()
    || process.env.SUPPORT_ADMIN_TOKEN?.trim()
    || "";
  return Boolean(expected) && safeSecretEqual(supplied, expected);
}
