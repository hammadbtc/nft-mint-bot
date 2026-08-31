import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createIncidentReplayBundle } from "@/lib/incident-replay";
import { safeErrorMessage, safeSecretEqual } from "@/lib/safety";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest, { params }: Context) {
  try {
    const expected = process.env.SUPPORT_ADMIN_TOKEN || "";
    if (!expected || !safeSecretEqual(req.headers.get("x-support-admin-token") || "", expected)) {
      return NextResponse.json({ error: "Mint support authorization required" }, { status: 401, headers: noStore });
    }
    const { id } = await params;
    const { trigger } = z.object({ trigger: z.string().trim().min(1).max(100).default("manual-review") }).strict().parse(await req.json().catch(() => ({})));
    return NextResponse.json(await createIncidentReplayBundle(id, trigger), { status: 201, headers: noStore });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not create incident replay bundle");
    return NextResponse.json({ error: message }, { status: 400, headers: noStore });
  }
}
