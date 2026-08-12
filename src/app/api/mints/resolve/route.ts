import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveMintInput } from "@/lib/adapters";
import { safeErrorMessage } from "@/lib/safety";

export async function POST(req: NextRequest) {
  try {
    const { input } = z.object({ input:z.string().trim().min(1).max(2048) }).parse(await req.json());
    const result = await resolveMintInput(input);
    return NextResponse.json(result, { status:result.supported?200:404, headers:{"Cache-Control":"no-store"} });
  } catch (error: unknown) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : safeErrorMessage(error, "Could not resolve mint");
    return NextResponse.json({ supported:false, reason:message }, { status:400, headers:{"Cache-Control":"no-store"} });
  }
}
