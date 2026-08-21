import { NextResponse } from "next/server";
import { deploymentVersion } from "@/lib/deployment";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok", service: "mintbot", version: deploymentVersion() },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
